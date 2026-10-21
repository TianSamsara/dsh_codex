import { CodexClient } from './client.mjs';
import { Session, normalize, hash } from './protocol.mjs';

export class BusyError extends Error { constructor(message = 'Bridge busy; retry shortly') { super(message); this.status = 429; } }
export class BridgeManager {
  constructor({ codex, state, Client = CodexClient, limit = 3, idleMs = 90000, sessionMs = 1800000, maxSessions = 24, batchMs = 40, webSearch = 'live' } = {}) {
    if (!['disabled', 'cached', 'live'].includes(webSearch)) throw new Error('Invalid hosted web search mode');
    Object.assign(this, { codex, state, Client, limit, idleMs, sessionMs, maxSessions, batchMs, webSearch });
    this.clients = new Set(); this.sessions = new Set(); this.calls = new Map(); this.explicit = new Map(); this.active = 0;
    this.stats = { processes: 0, processReuses: 0, sessionsStarted: 0, sessionReuses: 0 };
    this.timer = setInterval(() => { void this.sweep(); }, 15000); this.timer.unref?.();
  }
  lease(preferred) {
    if (this.closed) throw new BusyError('Bridge is draining');
    for (const entry of this.clients) if (entry.client.dead) this.discard(entry);
    if (preferred?.busy) throw new BusyError('This conversation already has a request in flight');
    let entry = preferred && this.clients.has(preferred) ? preferred : [...this.clients].find(e => !e.busy);
    const reused = Boolean(entry);
    if (!entry) {
      if (this.clients.size >= this.limit) throw new BusyError();
      const client = new this.Client({ codex: this.codex, state: this.state });
      entry = { client, busy: false, lastUsed: Date.now() }; this.clients.add(entry); this.stats.processes++;
      entry.ready = Promise.resolve().then(() => client.init());
    }
    entry.busy = true; this.active++; if (reused) this.stats.processReuses++;
    return { entry, reused };
  }
  release(entry, healthy) {
    this.active--; entry.busy = false; entry.lastUsed = Date.now();
    if (!healthy || entry.client.dead) this.discard(entry);
  }
  discard(entry) {
    if (!this.clients.delete(entry)) return;
    entry.client.close();
    for (const session of [...this.sessions]) if (session.entry === entry) this.remove(session);
  }
  remove(session) {
    this.sessions.delete(session);
    for (const id of session.allCalls) this.calls.delete(id);
    if (session.explicit && this.explicit.get(session.explicit) === session) this.explicit.delete(session.explicit);
    return session.close();
  }
  find(request) {
    if (request.explicit) return this.explicit.get(request.explicit);
    // Only a bridge-generated unpredictable tool id establishes implicit conversation ownership.
    // Identical text in two chats is never enough to share a native thread.
    for (const message of [...request.history].reverse()) for (const call of message.tool_calls || []) {
      const session = this.calls.get(call.id); if (session) return session;
    }
  }
  async models(signal, force = false) {
    const lease = this.lease(); let healthy = false;
    const abort = () => this.discard(lease.entry); signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) throw new Error('Request cancelled');
      await lease.entry.ready; await lease.entry.client.account();
      const data = await lease.entry.client.models(force); healthy = true; return data;
    } finally { signal?.removeEventListener('abort', abort); this.release(lease.entry, healthy); }
  }
  async answer(body, emit, signal) {
    const started = Date.now(), request = normalize(body);
    request.webSearch = body.tool_choice === 'none' ? 'disabled' : this.webSearch;
    let session = this.find(request);
    const lease = this.lease(session?.entry); const { entry } = lease; let healthy = false;
    const abort = () => this.discard(entry); signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) throw new Error('Request cancelled');
      await entry.ready;
      const [account, config, catalog] = await Promise.all([entry.client.account(), entry.client.configuration(), entry.client.models()]);
      let selected = catalog.find(m => (m.model || m.id) === request.model);
      const valid = model => model && (!request.requestedEffort || model.supportedReasoningEfforts?.some(e => e.reasoningEffort === request.requestedEffort));
      if (!valid(selected)) selected = (await entry.client.models(true)).find(m => (m.model || m.id) === request.model);
      if (!valid(selected)) throw new Error('Model or reasoning effort is unavailable in the Codex catalog');
      request.effort = request.requestedEffort || selected.defaultReasoningEffort;
      const policy = hash({ account, config, model: request.model, effort: request.effort, system: request.system, tools: request.tools, names: request.toolNames, webSearch: request.webSearch });
      const continuing = Boolean(session && !session.error && Date.now() - session.lastUsed < this.sessionMs && session.policy === policy && session.matches(request));
      if (session && !continuing) { await this.remove(session); session = null; }
      if (!session) {
        while (this.sessions.size >= this.maxSessions) {
          const oldest = [...this.sessions].filter(s => !s.entry.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
          if (!oldest) throw new BusyError('Too many live conversations');
          await this.remove(oldest);
        }
        session = new Session(entry.client, { ...request, history: undefined }, { cwd: this.state, batchMs: this.batchMs, onCall: (id, owner) => this.calls.set(id, owner) });
        Object.assign(session, { entry, policy, explicit: request.explicit }); this.sessions.add(session);
        if (request.explicit) this.explicit.set(request.explicit, session);
        await session.startThread(config); this.stats.sessionsStarted++;
      } else this.stats.sessionReuses++;
      const prepared = Date.now();
      const result = await session.run(request, emit, signal, continuing);
      healthy = true;
      return { ...result, bridge_timing: { total_ms: Date.now() - started, prepare_ms: prepared - started, inference_ms: Date.now() - prepared, process_reused: lease.reused, session_reused: continuing } };
    } finally { signal?.removeEventListener('abort', abort); this.release(entry, healthy); }
  }
  health() { const { processes: processesStarted, ...stats } = this.stats; return { active: this.active, processes: this.clients.size, sessions: this.sessions.size, processesStarted, ...stats }; }
  async sweep(now = Date.now()) {
    for (const session of [...this.sessions]) if (!session.entry.busy && (session.error || now - session.lastUsed >= this.sessionMs)) await this.remove(session);
    for (const entry of [...this.clients]) if (!entry.busy && ![...this.sessions].some(s => s.entry === entry) && now - entry.lastUsed >= this.idleMs) this.discard(entry);
  }
  close() { this.closed = true; clearInterval(this.timer); for (const entry of [...this.clients]) this.discard(entry); }
}
