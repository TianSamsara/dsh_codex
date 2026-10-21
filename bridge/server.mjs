import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeManager } from './manager.mjs';
import { VERSION } from './protocol.mjs';

export const safeError = error => String(error?.message || error).replace(/Bearer\s+\S+|[a-f0-9]{48,}/gi, '[redacted]').slice(0, 300);
export function createBridge({ key, port = 17654, manager, timeoutMs = 600000, log = console.log }) {
  let active = 0, drainUntil = 0;
  const server = http.createServer(async (req, res) => {
    const json = (status, data) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); } };
    if (req.headers.host !== `127.0.0.1:${port || server.address()?.port}` || req.headers.origin) return json(403, { error: { message: 'Local applications only' } });
    const actual = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${key}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return json(401, { error: { message: 'Invalid local bridge key' } });
    const draining = Date.now() < drainUntil;
    if (req.method === 'GET' && req.url === '/health') return json(200, { service: 'dsh-codex-bridge', auth: 'ChatGPT subscription', version: VERSION, active, draining, capabilities: { warm_process: true, metadata_cache: true, session_continuation: true, native_web_search: manager.webSearch !== 'disabled' }, web_search_mode: manager.webSearch, pool: manager.health() });
    // An authenticated drain blocks new work while existing HTTP operations finish.
    if (req.method === 'POST' && req.url === '/admin/drain') { drainUntil = Date.now() + 90000; return json(200, { draining: true, active }); }
    if (req.method === 'POST' && req.url === '/admin/resume') { drainUntil = 0; return json(200, { draining: false, active }); }
    const isModels = req.method === 'GET' && /^\/v1\/models(?:\?refresh=1)?$/.test(req.url);
    const isAnswer = req.method === 'POST' && req.url === '/v1/chat/completions';
    if (!isModels && !isAnswer) return json(404, { error: { message: 'Unknown endpoint' } });
    if (draining || active >= 3) return json(429, { error: { message: draining ? 'Bridge is restarting; retry shortly' : 'Bridge busy; retry shortly' } });
    active++; const controller = new AbortController(); let heartbeat;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const cancel = () => { if (!res.writableEnded) controller.abort(); }; res.on('close', cancel);
    try {
      if (isModels) {
        const models = await manager.models(controller.signal, req.url.endsWith('refresh=1'));
        return json(200, { object: 'list', data: models.map(m => ({ id: m.model || m.id, object: 'model', owned_by: 'codex-chatgpt', name: m.displayName, defaultReasoningEffort: m.defaultReasoningEffort, supportedReasoningEfforts: m.supportedReasoningEfforts })) });
      }
      const chunks = []; let size = 0;
      const stopUpload = () => req.destroy(new Error('Request cancelled'));
      controller.signal.addEventListener('abort', stopUpload, { once: true });
      try { for await (const chunk of req) { size += chunk.length; if (size > 24 * 1024 * 1024) throw Object.assign(new Error('Request too large'), { status: 413 }); chunks.push(chunk); } }
      finally { controller.signal.removeEventListener('abort', stopUpload); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof req.headers['x-dsh-session-id'] === 'string') body.conversation_id = req.headers['x-dsh-session-id'];
      const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000);
      const sse = (delta, finish_reason = null, usage) => { if (!res.destroyed) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`); };
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); sse({ role: 'assistant', content: '' });
        heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000);
      }
      const result = await manager.answer(body, body.stream ? delta => sse(delta) : undefined, controller.signal);
      if (body.stream) {
        if (result.tool_calls) sse({ tool_calls: result.tool_calls.map((call, index) => ({ index, ...call })) });
        sse({}, result.finish_reason, result.usage); res.end('data: [DONE]\n\n');
      } else json(200, { id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: result.content, ...(result.tool_calls ? { tool_calls: result.tool_calls } : {}) }, finish_reason: result.finish_reason }], usage: result.usage, bridge_timing: result.bridge_timing });
      // Timings and counters only: never log prompts, tool arguments, credentials, or account identity.
      log(`${new Date().toISOString()} ${body.model} ${result.finish_reason} ${JSON.stringify(result.bridge_timing)}`);
    } catch (error) {
      const message = safeError(error);
      if (res.headersSent) { if (!res.destroyed) res.end(`data: ${JSON.stringify({ error: { message } })}\n\ndata: [DONE]\n\n`); }
      else json(error.status || (controller.signal.aborted ? 504 : error instanceof SyntaxError ? 400 : 502), { error: { message, type: 'local_codex_bridge_error' } });
      log(`${new Date().toISOString()} error ${message}`);
    } finally { clearTimeout(timer); clearInterval(heartbeat); res.off('close', cancel); active--; }
  });
  server.on('close', () => manager.close());
  server.requestTimeout = timeoutMs; server.headersTimeout = 30000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.dirname(fileURLToPath(import.meta.url)), state = path.join(root, 'state');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const keyFile = path.join(state, 'local-key'); if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const key = readFileSync(keyFile, 'utf8').trim(); if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Invalid key file');
  const settings = JSON.parse(readFileSync(path.join(root, 'settings.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) throw new Error('Invalid port');
  const manager = new BridgeManager({ codex: settings.codex, state, webSearch: settings.webSearch ?? 'live' });
  const server = createBridge({ key, port: settings.port, manager });
  server.listen(settings.port, '127.0.0.1', () => console.log(`Harness Codex bridge ${VERSION}: http://127.0.0.1:${settings.port}/v1`));
  const shutdown = () => { server.close(); server.closeIdleConnections(); setTimeout(() => { manager.close(); process.exit(0); }, 3000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
