import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { VERSION } from './protocol.mjs';

export class CodexClient extends EventEmitter {
  constructor({ codex, state, spawnProcess = spawn }) {
    super(); this.setMaxListeners(64); this.seq = 0; this.pending = new Map(); this.dead = false;
    const env = { ...process.env }; delete env.OPENAI_API_KEY;
    const overrides = ['model_provider="openai"', 'forced_login_method="chatgpt"', 'features.shell_tool=false', 'features.multi_agent=false', 'features.apps=false', 'web_search="disabled"', 'sandbox_mode="read-only"', 'approval_policy="never"'];
    this.child = spawnProcess(codex, ['app-server', '--listen', 'stdio://', ...overrides.flatMap(value => ['-c', value])], { cwd: state, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', error => this.fail(error));
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) {
        if (message.method === 'item/tool/call') this.emit('tool', message);
        else this.write({ id: message.id, error: { code: -32601, message: 'Only Harness dynamic tools are supported' } });
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
      } else this.emit('notification', message);
    });
    lines.on('close', () => this.fail(new Error('Codex stream closed')));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => this.fail(new Error('Codex process exited')));
  }
  write(message) { if (!this.dead) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  fail(error) {
    if (this.dead) return; this.dead = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear(); this.emit('failure', error);
  }
  rpc(method, params, timeoutMs = 30000) {
    if (this.dead) return Promise.reject(new Error('Codex connection closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this.write({ id, method, params });
    });
  }
  async init() {
    await this.rpc('initialize', { clientInfo: { name: 'dsh_local_codex_bridge', title: 'Harness Codex bridge', version: VERSION }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized' });
  }
  async account() {
    const result = await this.rpc('account/read', { refreshToken: false });
    if (result.account?.type !== 'chatgpt') throw new Error('Codex must be signed in with ChatGPT; API key billing is disabled');
    return result.account;
  }
  async models(force = false) {
    if (!force && this.catalog && Date.now() < this.catalogUntil) return this.catalog;
    if (this.catalogLoading) return this.catalogLoading;
    this.catalogLoading = (async () => {
      const data = []; let cursor = null;
      do { const page = await this.rpc('model/list', { cursor, limit: 100 }, 60000); data.push(...page.data); cursor = page.nextCursor; } while (cursor && data.length < 500);
      this.catalog = data; this.catalogUntil = Date.now() + 300000; return data;
    })();
    try { return await this.catalogLoading; } finally { this.catalogLoading = null; }
  }
  async configuration() {
    if (this.config && Date.now() < this.configUntil) return this.config;
    const result = await this.rpc('config/read', { includeLayers: false });
    this.config = result.config || {}; this.configUntil = Date.now() + 60000; return this.config;
  }
  close() { this.fail(new Error('Codex connection retired')); this.child.kill(); }
}
