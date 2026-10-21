import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol';
import { BridgeManager, harnessProfile } from './core.mjs';
import { RepositoryUpdater } from './updater.mjs';

export const name = 'codex-local-bridge';
const initializers = [];
export default class CodexBridge extends TypertRemoteService {
  static inject = ['settings', 'agentDefaultModel', 'profileContext'];
  constructor(ctx) {
    super(ctx, 'codexBridge');
    for (const initialize of initializers) initialize.call(this);
    this.updater = new RepositoryUpdater({ dshHome: ctx.profileContext.home, profileDir: ctx.profileContext.dir });
    this.updateReady = this.updater.init();
    this.manager = new BridgeManager({ dshHome: ctx.profileContext.home,
      onConnected: async connection => {
        if (this.disposed) throw new Error('插件已停用，已取消配置写入');
        const form = ctx.settings.describe().find(s => s.ns === 'llm-pi-ai');
        if (!form) throw new Error('Harness 的 llm-pi-ai 插件尚未加载，无法配置模型');
        const previous = form.value.providers?.['codex-local'] || {};
        const next = harnessProfile(connection, previous);
        if (JSON.stringify(previous) !== JSON.stringify(next))
          await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'codex-local'], value: next }]);
        if (connection.makeDefault) await ctx.agentDefaultModel.saveSelection({ provider: 'codex-local', model: connection.model, ...(connection.effort ? { reasoningEffort: connection.effort } : {}) });
      }
    });
    ctx.effect(() => {
      this.ready = this.manager.load().then(async () => {
        const selected = ctx.agentDefaultModel.currentSelection();
        if (selected.provider === 'codex-local') {
          if (!this.manager.memory.model) this.manager.state.model = selected.model;
          if (this.manager.memory.effort === undefined && selected.reasoningEffort !== undefined) this.manager.state.effort = String(selected.reasoningEffort);
        }
        if (!this.manager.memory.root) await this.manager.discover();
      }).catch(error => ctx.logger.warn('Codex bridge: %s', error.message));
      return () => { this.disposed = true; };
    });
  }
  async status() { await Promise.all([this.ready, this.updateReady]); return { ...this.manager.status(), update: await this.updater.status() }; }
  async discover() { await this.ready; return this.manager.discover(); }
  async connect(request) { await this.ready; return this.manager.connect(request); }
  async autoSetup() { await this.ready; return this.manager.autoSetup(); }
  async forget() { await this.ready; return this.manager.forget(); }
  async reconnect() { await Promise.all([this.ready, this.updateReady]); if (['queued', 'installing'].includes((await this.updater.status()).status)) return this.manager.status(); return this.manager.reconnect(); }
  async checkUpdate() { await this.updateReady; await this.updater.check(); return this.status(); }
  async installUpdate() { await this.updateReady; if (this.manager.busy) throw new Error('正在配置桥接，请稍后更新插件'); await this.updater.start(); return this.status(); }
}

// Use the public stage-3 decorator API from plain ESM; no private descriptor manipulation.
for (const method of ['status', 'discover', 'connect', 'autoSetup', 'forget', 'reconnect', 'checkUpdate', 'installUpdate'])
  Remote(method)(CodexBridge.prototype[method], { kind: 'method', name: method, static: false, private: false, addInitializer: initialize => initializers.push(initialize) });
