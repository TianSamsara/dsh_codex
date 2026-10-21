import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { BridgeManager } from '../bridge/manager.mjs';
import { CodexClient } from '../bridge/client.mjs';
import { normalize, hash, historyInput, toolOutput } from '../bridge/protocol.mjs';
import { createBridge } from '../bridge/server.mjs';

const catalog = [{ id: 'test', model: 'test', displayName: 'Test', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }];
const tool = { type: 'function', function: { name: 'read_test', description: 'Read a test value', parameters: { type: 'object', properties: {} } } };
const initial = (text = 'Read value') => ({ model: 'test', messages: [{ role: 'user', content: text }], tools: [tool] });
const assistant = result => ({ role: 'assistant', content: result.content, ...(result.tool_calls ? { tool_calls: result.tool_calls } : {}) });
const continuation = (body, result, value = '42') => ({ ...body, messages: [...body.messages, assistant(result), ...result.tool_calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: value }))] });

class FakeClient extends EventEmitter {
  constructor() { super(); this.threads = new Map(); this.rpcs = []; this.writes = []; this.pendingTools = new Map(); this.seq = 0; }
  async init() { this.initialized = true; }
  async account() { return { type: 'chatgpt', id: 'local-test' }; }
  async models() { return catalog; }
  async configuration() { return this.config || {}; }
  async rpc(method, params) {
    this.rpcs.push({ method, params });
    if (method === 'thread/start') { const id = `thread-${++this.seq}`; this.threads.set(id, params); return { thread: { id } }; }
    if (method === 'thread/unsubscribe') { this.threads.delete(params.threadId); return {}; }
    if (method === 'turn/start') {
      queueMicrotask(() => {
        if (this.dead || this.hold) return;
        const id = params.threadId, row = this.threads.get(id);
        if (!row.dynamicTools.length || this.finalOnly) return this.finish(id, 'Done');
        const count = this.parallel ? 2 : 1;
        for (let i = 0; i < count; i++) {
          const rpcId = ++this.seq; this.pendingTools.set(rpcId, id);
          this.emit('tool', { id: rpcId, method: 'item/tool/call', params: { threadId: id, turnId: 'turn', callId: `native-${rpcId}`, tool: 'dsh_tool_0', arguments: { index: i } } });
        }
      });
      return { turn: { id: 'turn' } };
    }
  }
  write(message) {
    this.writes.push(message); const threadId = this.pendingTools.get(message.id); this.pendingTools.delete(message.id);
    if (![...this.pendingTools.values()].includes(threadId)) queueMicrotask(() => this.finish(threadId, message.result.contentItems.map(c => c.text || '[image]').join('')));
  }
  finish(threadId, text) {
    this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId, itemId: 'reply', delta: text } });
    this.emit('notification', { method: 'item/completed', params: { threadId, item: { type: 'agentMessage', id: 'reply', text } } });
    this.emit('notification', { method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: { total: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 4 } } } });
    this.emit('notification', { method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } });
  }
  close() { if (this.dead) return; this.dead = true; this.emit('failure', new Error('closed')); }
}
function fixture(t, options = {}) { const manager = new BridgeManager({ Client: FakeClient, state: '.', batchMs: 1, ...options }); t.after(() => manager.close()); return manager; }

test('tool results resume the original native turn and reuse its process', async t => {
  const m = fixture(t), body = initial(), first = await m.answer(body);
  const client = [...m.clients][0].client; assert.equal(first.finish_reason, 'tool_calls');
  assert.equal(client.writes.length, 0, 'tool must remain unanswered until Harness runs it');
  const second = await m.answer(continuation(body, first));
  assert.equal(second.content, '42'); assert.equal(second.bridge_timing.session_reused, true);
  assert.equal(second.bridge_timing.process_reused, true);
  assert.equal(client.rpcs.filter(r => r.method === 'thread/start').length, 1);
  assert.equal(client.rpcs.filter(r => r.method === 'turn/start').length, 1);
  assert.equal(client.writes[0].result.contentItems[0].type, 'inputText');
});

test('parallel tool outputs retain RPC ownership even when results arrive in reverse order', async t => {
  const m = fixture(t); const lease = m.lease(); await lease.entry.ready; lease.entry.client.parallel = true; m.release(lease.entry, true);
  const body = initial(), first = await m.answer(body); assert.equal(first.tool_calls.length, 2);
  const next = continuation(body, first); next.messages = [...next.messages.slice(0, 2), ...next.messages.slice(2).reverse()];
  const second = await m.answer(next); assert.equal(second.finish_reason, 'stop');
  assert.equal(lease.entry.client.writes.length, 2);
  assert.notEqual(lease.entry.client.writes[0].id, lease.entry.client.writes[1].id);
});

test('identical new chats share a process but never a native thread', async t => {
  const m = fixture(t); const first = await m.answer(initial()), second = await m.answer(initial());
  assert.notEqual(first.tool_calls[0].id, second.tool_calls[0].id);
  assert.equal(m.stats.processes, 1); assert.equal(m.stats.sessionsStarted, 2);
  const resumed = await m.answer(continuation(initial(), first, 'first chat'));
  assert.equal(resumed.content, 'first chat');
});

test('edited histories, changed effort/tools/config and expired sessions start fresh threads', async t => {
  for (const change of ['history', 'effort', 'tools', 'config', 'expired']) {
    const m = fixture(t); const body = initial(), first = await m.answer(body); const next = continuation(body, first);
    if (change === 'history') next.messages[0] = { role: 'user', content: 'Edited request' };
    if (change === 'effort') next.reasoning_effort = 'high';
    if (change === 'tools') next.tools = [{ ...tool, function: { ...tool.function, description: 'Changed tool' } }];
    if (change === 'config') [...m.clients][0].client.config = { revision: 2 };
    if (change === 'expired') [...m.sessions][0].lastUsed -= m.sessionMs + 1;
    const result = await m.answer(next); assert.equal(result.bridge_timing.session_reused, false, change);
    assert.equal(m.stats.sessionsStarted, 2, change);
  }
});

test('missing or duplicate tool outputs are rejected without acknowledging native requests', async t => {
  const m = fixture(t), body = initial(), first = await m.answer(body), next = continuation(body, first);
  next.messages.push(next.messages.at(-1)); const client = [...m.clients][0].client;
  await assert.rejects(m.answer(next), /do not match/); assert.equal(client.writes.length, 0); assert.equal(m.sessions.size, 0);
});

test('text-only continuation requires an explicit id, and prefix edits still invalidate it', async t => {
  const m = fixture(t), body = { ...initial(), tools: [], conversation_id: 'one' };
  const first = await m.answer(body);
  const second = await m.answer({ ...body, messages: [...body.messages, assistant(first), { role: 'user', content: 'Continue' }] });
  assert.equal(second.bridge_timing.session_reused, true);
  assert.equal(m.stats.sessionsStarted, 1);
});

test('cancellation retires the process and every attached session; next request recovers', async t => {
  const m = fixture(t), first = await m.answer(initial()); const client = [...m.clients][0].client; client.hold = true;
  const controller = new AbortController();
  const pending = m.answer({ ...initial('Hold'), tools: [] }, undefined, controller.signal);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, /closed|cancelled/); assert.equal(client.dead, true); assert.equal(m.sessions.size, 0);
  const result = await m.answer(initial()); assert.equal(result.finish_reason, 'tool_calls'); assert.equal(m.stats.processes, 2);
  assert.equal(m.calls.has(first.tool_calls[0].id), false);
});

test('idle sessions unload before their process, and live requests are not evicted', async t => {
  const m = fixture(t); await m.answer(initial()); const entry = [...m.clients][0];
  const lease = m.lease(entry); await m.sweep(Date.now() + m.sessionMs + 10);
  assert.equal(m.sessions.size, 1); assert.equal(entry.client.dead, undefined); m.release(lease.entry, true);
  await m.sweep(Date.now() + m.sessionMs + 10); assert.equal(m.sessions.size, 0); assert.equal(entry.client.dead, true);
  assert.equal(entry.client.rpcs.some(r => r.method === 'thread/unsubscribe'), true);
});

test('client caches models/configuration but refreshes expired data and still checks authentication', async t => {
  const counts = {}, child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  let buffer = '';
  child.stdin.on('data', bytes => { buffer += bytes; for (;;) { const end = buffer.indexOf('\n'); if (end < 0) break; const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); if (request.id === undefined) continue;
    counts[request.method] = (counts[request.method] || 0) + 1;
    const result = request.method === 'account/read' ? { account: { type: 'chatgpt' } } : request.method === 'model/list' ? { data: catalog } : request.method === 'config/read' ? { config: {} } : {};
    child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
  } });
  const client = new CodexClient({ state: '.', codex: 'fake', spawnProcess: () => child }); t.after(() => client.close());
  await client.init(); await client.account(); await client.models(); await client.configuration();
  await client.account(); await client.models(); await client.configuration();
  assert.equal(counts['initialize'], 1); assert.equal(counts['account/read'], 2); assert.equal(counts['model/list'], 1); assert.equal(counts['config/read'], 1);
  await client.models(true); client.configUntil = 0; await client.configuration(); assert.equal(counts['model/list'], 2); assert.equal(counts['config/read'], 2);
});

test('inline images survive both initial history and native tool outputs; file URLs are rejected', () => {
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } };
  const req = normalize({ ...initial(), messages: [{ role: 'user', content: [image] }] });
  assert.equal(historyInput(req.history)[1].type, 'image'); assert.equal(toolOutput([image])[0].type, 'inputImage');
  assert.throws(() => normalize({ ...initial(), messages: [{ role: 'user', content: [{ ...image, image_url: { url: 'file:///secret' } }] }] }), /Only text/);
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
});

test('HTTP authenticates, streams tool calls, resumes, reports capabilities and drains gracefully', async t => {
  const manager = fixture(t), key = 'a'.repeat(64), server = createBridge({ key, port: 0, manager, log() {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/health')).status, 401);
  assert.equal((await fetch(base + '/health', { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
  const health = await (await fetch(base + '/health', { headers })).json(); assert.equal(health.capabilities.session_continuation, true);
  const body = initial(); const first = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) })).json();
  const continued = continuation(body, first.choices[0].message);
  const stream = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ ...continued, stream: true }) })).text();
  assert.match(stream, /42/); assert.match(stream, /\[DONE\]/); assert.equal(manager.stats.sessionReuses, 1);
  await fetch(base + '/admin/drain', { method: 'POST', headers }); assert.equal((await fetch(base + '/v1/models', { headers })).status, 429);
});
