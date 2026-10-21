import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { findGit } from './update-worker.mjs';

export const PACKAGE = 'dsh-plugin-codex-local-bridge';
export const REPOSITORY = 'https://github.com/TianSamsara/dsh_codex';
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[\w.-]{1,60})?$/;
const running = status => ['queued', 'installing'].includes(status);
const safeMessage = error => String(error?.message || error).replace(/Bearer\s+\S+|[a-f0-9]{48,}/gi, '[隐藏密钥]').slice(0, 260);
const readJSON = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const execute = promisify(execFile);
export async function gitHead() {
  const git = await findGit();
  const { stdout } = await execute(git, ['-c', 'http.version=HTTP/1.1', '-c', 'http.sslBackend=openssl', 'ls-remote', REPOSITORY, 'refs/heads/main'], { windowsHide: true, timeout: 20000, maxBuffer: 65536, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
  const sha = stdout.match(/^([a-f0-9]{40})\s+refs\/heads\/main\s*$/m)?.[1];
  if (!sha) throw new Error('无法读取仓库 main 分支的提交'); return sha;
}
export async function atomicJSON(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
export async function repositoryJSON(url, fetcher = fetch, maxBytes = 1024 * 1024) {
  const parsed = new URL(url);
  if (!['api.github.com', 'raw.githubusercontent.com'].includes(parsed.hostname) || parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('仓库更新地址不受支持');
  const response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-codex-plugin-updater' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (response.status === 403 || response.status === 429) throw new Error('GitHub 暂时限制更新检查，请稍后重试');
  if (!response.ok) throw new Error(`读取 GitHub 更新失败（HTTP ${response.status}）`);
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) throw new Error('仓库更新响应过大'); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function readRepository(fetcher = fetch, headReader = gitHead) {
  let sha;
  try { sha = (await repositoryJSON('https://api.github.com/repos/TianSamsara/dsh_codex/commits/main', fetcher)).sha; }
  catch { sha = await headReader(); }
  if (!SHA.test(sha || '')) throw new Error('GitHub 返回的提交标识无效');
  const manifest = await repositoryJSON(`https://raw.githubusercontent.com/TianSamsara/dsh_codex/${sha}/package.json`, fetcher, 65536);
  if (manifest.name !== PACKAGE || !VERSION.test(manifest.version || '') || !manifest.dsh?.bundle?.patch) throw new Error('仓库提交不是有效的 Codex 桥接插件');
  return { commit: sha, version: manifest.version };
}
export function installedCommit(lock) {
  return lock.match(/dsh-plugin-codex-local-bridge:\r?\n(?: {8}[^\n]*\r?\n)*? {8}version: ['"]?https:\/\/codeload\.github\.com\/TianSamsara\/dsh_codex\/tar\.gz\/([a-f0-9]{40})(?=[\s('"]|$)/)?.[1] || '';
}
export function compareVersions(a, b) {
  const [coreA, preA] = a.split(/-(.*)/s), [coreB, preB] = b.split(/-(.*)/s);
  const x = coreA.split('.').map(Number), y = coreB.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  if (!preA && !preB) return 0; if (!preA) return 1; if (!preB) return -1;
  return preA.localeCompare(preB, undefined, { numeric: true });
}

async function locateHarness() {
  const candidates = [process.execPath, path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')];
  for (const exe of candidates) {
    const resources = path.join(path.dirname(exe), 'resources');
    try { await fs.access(path.join(resources, 'app.asar')); if (/DeepSeek Harness\.exe$/i.test(exe)) return { exe, resources }; } catch {}
  }
  throw new Error('无法找到 Harness 安装目录，请在 Harness 中使用更新按钮');
}

export class RepositoryUpdater {
  constructor({ dshHome, profileDir, packageRoot = fileURLToPath(new URL('../', import.meta.url)), fetcher = fetch, headReader = gitHead, launch, harness = locateHarness } = {}) {
    Object.assign(this, { dshHome, profileDir, packageRoot, fetcher, headReader, harness });
    this.directory = path.join(dshHome, 'storages', 'codex-local-bridge', 'updates');
    this.launch = launch || ((exe, args, options) => new Promise((resolve, reject) => {
      const child = spawn(exe, args, options); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(child.pid); });
    }));
    this.state = { status: 'idle', repository: REPOSITORY, currentVersion: '', installedVersion: '', currentCommit: '', latestVersion: '', latestCommit: '', available: false, message: '', restartRequired: false };
  }
  async init() {
    const manifest = await readJSON(path.join(this.packageRoot, 'package.json'));
    if (manifest.name !== PACKAGE || !VERSION.test(manifest.version)) throw new Error('当前插件版本元数据无效');
    this.state.currentVersion = this.state.installedVersion = manifest.version;
    await this.refreshInstalled(); return this.status();
  }
  async refreshInstalled() {
    try { const installed = await readJSON(path.join(this.profileDir, 'node_modules', PACKAGE, 'package.json')); if (installed.name === PACKAGE && VERSION.test(installed.version)) this.state.installedVersion = installed.version; } catch {}
    try { this.state.currentCommit = installedCommit(await fs.readFile(path.join(this.profileDir, 'pnpm-lock.yaml'), 'utf8')); } catch {}
  }
  async status() {
    try {
      const pointer = await readJSON(path.join(this.directory, 'latest.json'));
      if (/^[a-f0-9-]{36}$/.test(pointer.id) && pointer.id !== this.ignoredJob) {
        const job = await readJSON(path.join(this.directory, pointer.id, 'status.json'));
        if (job.id === pointer.id && ['queued', 'installing', 'success', 'error'].includes(job.status)) {
          let message = String(job.message || '').slice(0, 260), status = job.status;
          if (running(status)) {
            let pid = job.pid;
            if (!pid) { try { pid = (await readJSON(path.join(this.directory, pointer.id, 'pid.json'))).pid; } catch {} }
            let stopped = !pid && Date.now() - (job.updatedAt || 0) > 60000;
            if (pid) { try { process.kill(pid, 0); } catch { stopped = true; } }
            if (stopped) {
              status = 'error'; message = '更新进程已退出，请重新检查更新后重试';
              try { if ((await fs.readFile(path.join(this.directory, 'update.lock'), 'utf8')) === job.id) await fs.unlink(path.join(this.directory, 'update.lock')); } catch {}
              await atomicJSON(path.join(this.directory, pointer.id, 'status.json'), { ...job, status, message });
            }
          }
          const restarted = job.hostPid && job.hostPid !== process.pid;
          if (job.status === 'success' && restarted) message = `插件已更新至 ${job.version || this.state.installedVersion}`;
          Object.assign(this.state, { status, message, restartRequired: job.status === 'success' && !restarted, jobId: job.id });
          if (job.status === 'success') { await this.refreshInstalled(); this.state.available = false; }
        }
      }
    } catch {}
    return structuredClone(this.state);
  }
  async check() {
    const current = await this.status();
    if (this.busy || running(current.status)) throw new Error('正在更新插件，请稍候');
    if (!VERSION.test(this.state.currentVersion)) await this.init();
    this.ignoredJob = current.jobId;
    this.busy = true; this.state.status = 'checking'; this.state.message = '正在读取 GitHub main 分支';
    try {
      const latest = await readRepository(this.fetcher, this.headReader); await this.refreshInstalled();
      const order = compareVersions(latest.version, this.state.installedVersion);
      const available = order > 0 || (order === 0 && Boolean(this.state.currentCommit) && latest.commit !== this.state.currentCommit);
      Object.assign(this.state, { status: 'checked', latestVersion: latest.version, latestCommit: latest.commit, available, checkedAt: Date.now(),
        message: available ? '发现仓库更新，可点击“更新插件”安装此提交' : order < 0 ? '本机版本高于仓库版本，保留本机版本' : '当前已是仓库最新版本' });
      return structuredClone(this.state);
    } catch (error) { this.state.status = 'error'; this.state.available = false; this.state.message = safeMessage(error); throw new Error(this.state.message); }
    finally { this.busy = false; }
  }
  async start() {
    const current = await this.status();
    if (this.busy || running(current.status)) throw new Error('正在更新插件，请稍候');
    if (!this.state.available || !SHA.test(this.state.latestCommit) || Date.now() - (this.state.checkedAt || 0) > 600000) throw new Error('请先检查仓库更新，再点击“更新插件”');
    this.busy = true; let lock;
    const id = randomUUID(), directory = path.join(this.directory, id);
    try {
      const profile = await readJSON(path.join(this.profileDir, 'package.json'));
      if (/^(link:|file:)/.test(profile.dependencies?.[PACKAGE] || '')) throw new Error('当前使用本地开发链接。为保留源码，请先从 GitHub 仓库安装插件后再使用仓库更新');
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      lock = await fs.open(path.join(this.directory, 'update.lock'), 'wx', 0o600);
      await lock.writeFile(id); await lock.close(); lock = null;
      const { exe, resources } = await this.harness();
      const profileName = path.basename(this.profileDir);
      if (!/^[\w.-]{1,100}$/.test(profileName) || path.resolve(this.profileDir) !== path.resolve(this.dshHome, 'profiles', profileName)) throw new Error('当前 Harness profile 路径不受支持');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.copyFile(new URL('./update-worker.mjs', import.meta.url), path.join(directory, 'worker.mjs'));
      await fs.copyFile(new URL('./install-cli.mjs', import.meta.url), path.join(directory, 'install-cli.mjs'));
      const config = { id, commit: this.state.latestCommit, version: this.state.latestVersion, dshHome: this.dshHome, profileDir: this.profileDir, profileName, exe, resources, hostPid: process.pid };
      await atomicJSON(path.join(directory, 'job.json'), config);
      await atomicJSON(path.join(directory, 'status.json'), { id, status: 'queued', message: '更新已排队，正在准备安装环境', updatedAt: Date.now() });
      await atomicJSON(path.join(this.directory, 'latest.json'), { id });
      const pid = await this.launch(exe, ['--expose-internals', path.join(directory, 'worker.mjs'), path.join(directory, 'job.json')], { cwd: directory, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, windowsHide: true, stdio: 'ignore' });
      this.state.status = 'queued'; this.state.message = '更新已在后台开始，桥接服务继续运行'; this.state.jobId = id;
      await atomicJSON(path.join(directory, 'pid.json'), { pid });
      return structuredClone(this.state);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('另一个插件更新正在执行，请稍候');
      this.state.status = 'error'; this.state.message = safeMessage(error);
      try { if ((await fs.readFile(path.join(this.directory, 'update.lock'), 'utf8')) === id) await fs.unlink(path.join(this.directory, 'update.lock')); } catch {}
      try { await atomicJSON(path.join(directory, 'status.json'), { id, status: 'error', message: this.state.message }); } catch {}
      throw new Error(this.state.message);
    } finally { await lock?.close(); this.busy = false; }
  }
}
