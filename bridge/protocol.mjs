import { createHash, randomUUID } from 'node:crypto';

export const VERSION = '1.1.1';
export const stable = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, sort(value[key])]));
  return value;
}
export const hash = value => createHash('sha256').update(stable(value)).digest('hex');
export function normalize(body) {
  if (!body || !/^[\w.:-]{1,120}$/.test(body.model || '') || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 10000) throw new Error('Invalid model or messages');
  if (body.reasoning_effort != null && !/^[a-z]{1,20}$/.test(body.reasoning_effort)) throw new Error('Invalid reasoning effort');
  if (body.tool_choice && body.tool_choice !== 'none' && body.tool_choice !== 'auto') throw new Error('Only auto/none tool_choice is supported');
  const rawTools = body.tool_choice === 'none' ? [] : body.tools || [];
  if (!Array.isArray(rawTools) || rawTools.length > 256) throw new Error('Invalid tools');
  const names = new Set();
  const tools = rawTools.map((tool, index) => {
    if (tool.type !== 'function' || !/^[\w.:-]{1,120}$/.test(tool.function?.name || '') || names.has(tool.function.name)) throw new Error('Invalid or duplicate function tool');
    names.add(tool.function.name);
    return { type: 'function', name: `dsh_tool_${index}`, description: `Harness tool ${tool.function.name}. ${tool.function.description || ''}`, inputSchema: tool.function.parameters || { type: 'object', properties: {} }, deferLoading: false };
  });
  const messages = body.messages.map(message => {
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) throw new Error('Invalid message role');
    const content = message.content ?? '';
    validateContent(content);
    const row = { role: message.role, content };
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !message.tool_call_id || message.tool_call_id.length > 200) throw new Error('Missing tool_call_id');
      row.tool_call_id = message.tool_call_id;
    }
    if (message.tool_calls) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) throw new Error('Invalid tool calls');
      row.tool_calls = message.tool_calls.map(call => {
        if (typeof call.id !== 'string' || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') throw new Error('Invalid tool call');
        let args; try { args = JSON.parse(call.function.arguments); } catch { throw new Error('Invalid tool arguments'); }
        return { id: call.id, type: 'function', function: { name: call.function.name, arguments: stable(args) } };
      });
    }
    return row;
  });
  const system = messages.filter(m => ['system', 'developer'].includes(m.role)).map(m => typeof m.content === 'string' ? m.content : stable(m.content)).join('\n\n');
  const history = messages.filter(m => !['system', 'developer'].includes(m.role));
  if (!history.length) throw new Error('Conversation is empty');
  return { model: body.model, requestedEffort: body.reasoning_effort || '', system, history, tools, toolNames: rawTools.map(t => t.function.name), explicit: typeof body.conversation_id === 'string' ? body.conversation_id.slice(0, 200) : '' };
}
function validateContent(content) {
  if (typeof content === 'string') return;
  if (!Array.isArray(content)) throw new Error('Invalid message content');
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') continue;
    if (part.type === 'image_url' && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(part.image_url?.url || '')) continue;
    throw new Error('Only text and inline images are supported');
  }
}
export function historyInput(history) {
  const images = [];
  const rows = history.map(message => ({ ...message, content: typeof message.content === 'string' ? message.content : message.content.map(part => {
    if (part.type === 'text') return part.text;
    images.push({ type: 'image', url: part.image_url.url }); return `[Attached image ${images.length}]`;
  }).join('\n') }));
  return [{ type: 'text', text: stable(rows) }, ...images];
}
export function toolOutput(content) {
  return typeof content === 'string' ? [{ type: 'inputText', text: content }] : content.map(part => part.type === 'text' ? { type: 'inputText', text: part.text } : { type: 'inputImage', imageUrl: part.image_url.url });
}
const INSTRUCTIONS = 'You are the model backend for DeepSeek Harness. Follow its application instructions below. JSON input is conversation history with role labels; continue from the last message. Use only provided dynamic tools, executed by Harness under Harness permissions. Codex read-only sandbox describes this private backend, not the Harness project. Use the actual project directory from Harness context or tool results. Do not execute local Codex tools, read local files, or inspect the local machine. Do not repeat completed tool calls. Tool names dsh_tool_N map to Harness names in their descriptions. Return assistant text when no tool is needed.\n\n';

// A live native turn remains paused across HTTP responses until Harness supplies its tool results.
export class Session {
  constructor(client, request, { cwd, onCall = () => {}, batchMs = 40 } = {}) {
    Object.assign(this, { client, request, cwd, onCall, batchMs });
    this.id = randomUUID(); this.pending = new Map(); this.allCalls = new Set(); this.messages = new Map(); this.lastUsed = Date.now();
    this.onTool = message => {
      const p = message.params; if (p.threadId !== this.threadId) return;
      const index = request.tools.findIndex(tool => tool.name === p.tool);
      if (index < 0) { this.fail(new Error('Unknown native tool')); return; }
      const id = `dsh_${randomUUID().replaceAll('-', '')}`;
      const call = { id, type: 'function', function: { name: request.toolNames[index], arguments: stable(p.arguments) } };
      this.pending.set(id, { rpcId: message.id, call, sent: false }); this.allCalls.add(id); this.onCall(id, this);
      this.flushSoon();
    };
    this.onEvent = ({ method, params: p }) => {
      if (p?.threadId !== this.threadId) return;
      if (method === 'item/agentMessage/delta') { this.messages.set(p.itemId, (this.messages.get(p.itemId) || '') + p.delta); this.waiter?.emit?.({ content: p.delta }); }
      if (method === 'item/completed' && p.item?.type === 'agentMessage') this.messages.set(p.item.id, p.item.text);
      if (method === 'thread/tokenUsage/updated') {
        const u = p.tokenUsage?.total; if (u) this.totalUsage = u;
      }
      if (method === 'turn/completed') {
        if (p.turn.status !== 'completed') this.fail(new Error(p.turn.error?.message || `Codex turn ${p.turn.status}`));
        else { this.completed = true; this.flush(); }
      }
    };
    this.onFailure = error => this.fail(error);
    client.on('tool', this.onTool); client.on('notification', this.onEvent); client.on('failure', this.onFailure);
  }
  async startThread(config) {
    const disabled = Object.fromEntries(Object.keys(config.mcp_servers || {}).map(name => [name, { enabled: false }]));
    const result = await this.client.rpc('thread/start', { model: this.request.model, modelProvider: 'openai', cwd: this.cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', config: { 'features.shell_tool': false, 'features.apps': false, 'features.multi_agent': false, web_search: 'disabled', mcp_servers: disabled }, baseInstructions: INSTRUCTIONS + this.request.system, dynamicTools: this.request.tools });
    this.threadId = result.thread.id;
  }
  matches(request) {
    return this.expectedCount && request.history.length > this.expectedCount && hash(request.history.slice(0, this.expectedCount)) === this.expectedHash;
  }
  async run(request, emit, signal, continuing = false) {
    if (this.waiter) throw new Error('Conversation already has an active request');
    if (this.error) throw this.error;
    const tail = continuing ? request.history.slice(this.expectedCount) : request.history;
    const awaiting = [...this.pending.values()].filter(p => p.sent);
    let results;
    if (awaiting.length) {
      // Exact ownership/count prevents wrong-session output and accidentally acknowledging a tool twice.
      if (tail.length !== awaiting.length || tail.some(m => m.role !== 'tool') || new Set(tail.map(m => m.tool_call_id)).size !== tail.length || awaiting.some(p => !tail.some(m => m.tool_call_id === p.call.id))) throw new Error('Tool results do not match pending calls');
      results = awaiting.map(p => ({ pending: p, output: toolOutput(tail.find(m => m.tool_call_id === p.call.id).content) }));
    } else if (continuing && !this.completed) throw new Error('Conversation is still running');
    const previousUsage = this.reportedUsage || {};
    this.completed = false; this.messages.clear();
    const result = await new Promise((resolve, reject) => {
      const abort = () => this.fail(new Error('Request cancelled'));
      this.waiter = { resolve, reject, emit, signal, abort }; signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      if (results) {
        for (const { pending, output } of results) { this.pending.delete(pending.call.id); this.client.write({ id: pending.rpcId, result: { contentItems: output, success: true } }); }
        this.flushSoon();
      } else {
        this.client.rpc('turn/start', { threadId: this.threadId, model: request.model, ...(request.effort ? { effort: request.effort } : {}), input: historyInput(tail) }).catch(error => this.fail(error));
      }
    });
    const u = this.totalUsage || {}, delta = key => Math.max(0, (u[key] || 0) - (previousUsage[key] || 0));
    if (this.totalUsage) { result.usage = { prompt_tokens: delta('inputTokens'), completion_tokens: delta('outputTokens'), total_tokens: delta('totalTokens'), prompt_tokens_details: { cached_tokens: delta('cachedInputTokens') } }; this.reportedUsage = { ...u }; }
    const assistant = { role: 'assistant', content: result.content || '', ...(result.tool_calls ? { tool_calls: result.tool_calls } : {}) };
    this.expectedCount = request.history.length + 1; this.expectedHash = hash([...request.history, assistant]); this.lastUsed = Date.now();
    return result;
  }
  flushSoon() {
    if (!this.waiter || this.batchTimer || ![...this.pending.values()].some(p => !p.sent)) return;
    this.batchTimer = setTimeout(() => { this.batchTimer = null; this.flush(); }, this.batchMs);
  }
  flush() {
    if (!this.waiter) return;
    const pending = [...this.pending.values()].filter(p => !p.sent);
    if (!pending.length && !this.completed) return;
    pending.forEach(p => { p.sent = true; });
    const result = { content: [...this.messages.values()].join('\n') || null, ...(pending.length ? { tool_calls: pending.map(p => p.call) } : {}), finish_reason: pending.length ? 'tool_calls' : 'stop' };
    this.settle(null, result);
  }
  settle(error, result) {
    clearTimeout(this.batchTimer); this.batchTimer = null;
    const waiter = this.waiter; this.waiter = null;
    if (waiter) { waiter.signal?.removeEventListener('abort', waiter.abort); error ? waiter.reject(error) : waiter.resolve(result); }
  }
  fail(error) { this.error = error; this.settle(error); }
  async close() {
    this.fail(new Error('Conversation retired'));
    this.client.off('tool', this.onTool); this.client.off('notification', this.onEvent); this.client.off('failure', this.onFailure);
    if (!this.client.dead && this.threadId) {
      // Unsubscribing also unloads ephemeral sessions, including turns waiting for tool results.
      try { await this.client.rpc('thread/unsubscribe', { threadId: this.threadId }, 2000); } catch { this.client.close(); }
    }
  }
}
