import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const managedRoot = dshHome => path.join(dshHome, 'storages', 'codex-local-bridge', 'runtime');
export const RUNTIME_FILES = ['server.mjs', 'client.mjs', 'manager.mjs', 'protocol.mjs', 'Start-Bridge.ps1'];
const isFile = async file => { try { return (await fs.stat(file)).isFile(); } catch { return false; } };
const readJSON = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));

export async function findExecutables({ env = process.env, home = os.homedir(), execPath = process.execPath, versions = process.versions, platform = process.platform } = {}) {
  if (platform !== 'win32') throw new Error('面板自动初始化目前支持 Windows');
  if (Number(versions.node.split('.')[0]) < 20) throw new Error('Harness 内置运行时过旧，请更新 Harness 后重试');
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const candidates = [env.CODEX_BIN];
  for (const directory of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) candidates.push(path.join(directory.replace(/^"|"$/g, ''), 'codex.exe'));
  const bin = path.join(local, 'OpenAI', 'Codex', 'bin');
  candidates.push(path.join(bin, 'codex.exe'));
  try {
    const folders = (await fs.readdir(bin, { withFileTypes: true })).filter(item => item.isDirectory()).slice(0, 40);
    const ordered = await Promise.all(folders.map(async item => ({ root: path.join(bin, item.name), modified: (await fs.stat(path.join(bin, item.name))).mtimeMs })));
    ordered.sort((a, b) => b.modified - a.modified);
    for (const folder of ordered) candidates.push(path.join(folder.root, 'codex.exe'), path.join(folder.root, 'resources', 'codex.exe'));
  } catch {}
  for (const target of ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']) {
    for (const npmRoot of [path.join(roaming, 'npm', 'node_modules'), ...((env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map(p => path.join(p, 'node_modules')))]) {
      candidates.push(path.join(npmRoot, '@openai', 'codex', 'vendor', target, 'codex', 'codex.exe'));
      for (const arch of ['x64', 'arm64']) candidates.push(path.join(npmRoot, '@openai', `codex-win32-${arch}`, 'vendor', target, 'codex', 'codex.exe'), path.join(npmRoot, '@openai', 'codex', 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', target, 'codex', 'codex.exe'));
    }
  }
  let codex;
  for (const candidate of [...new Set(candidates.filter(Boolean))].slice(0, 600)) if (path.isAbsolute(candidate) && /\.exe$/i.test(candidate) && await isFile(candidate)) { codex = await fs.realpath(candidate); break; }
  if (!codex) throw new Error('未找到本机 Codex。请先安装并打开 Codex，完成 ChatGPT 登录后重试；也可设置 CODEX_BIN 指向 codex.exe');
  if (!await isFile(execPath)) throw new Error('无法找到 Harness 的内置运行时，请更新 Harness 后重试');
  return { codex, node: execPath, electronNode: Boolean(versions.electron) };
}

export function portAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

// Install only bundled code into a private writable directory, never into node_modules.
export async function prepareRuntime({ dshHome, bundleRoot = fileURLToPath(new URL('../bridge/', import.meta.url)), detect = findExecutables, available = portAvailable, onProgress = () => {} } = {}) {
  if (!dshHome || !path.isAbsolute(dshHome)) throw new Error('Harness 用户目录不可用');
  const root = managedRoot(dshHome);
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('自动桥接目录被其他文件或链接占用，请在高级设置中选择桥接');
    const files = await fs.readdir(root);
    if (files.length) {
      let marker; try { marker = await readJSON(path.join(root, 'installation.json')); } catch {}
      if (marker?.owner !== 'dsh-plugin-codex-local-bridge') throw new Error('自动桥接目录已有其他内容，为保留文件，请在高级设置中选择桥接');
      const settings = await readJSON(path.join(root, 'settings.json'));
      const key = (await fs.readFile(path.join(root, 'state', 'local-key'), 'utf8')).trim();
      if (!/^[a-f0-9]{64}$/i.test(key) || !Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) throw new Error('已有自动桥接配置损坏，请检查该目录；不会覆盖原密钥');
      for (const file of RUNTIME_FILES) if (!await isFile(path.join(root, file))) throw new Error('已有自动桥接文件不完整，请检查该目录；不会覆盖原文件');
      onProgress('已找到自动创建的桥接');
      return { root, created: false };
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  onProgress('正在检测本机 Codex 和运行环境');
  const executables = await detect();
  // Read the complete bundled payload before creating any files.
  const sources = await Promise.all(RUNTIME_FILES.map(file => fs.readFile(path.join(bundleRoot, file))));
  onProgress('正在选择可用的本机端口');
  let port;
  for (let candidate = 17654; candidate < 17674; candidate++) if (await available(candidate)) { port = candidate; break; }
  if (!port) throw new Error('本机桥接端口均被占用，请关闭不用的桥接后重试');
  const parent = path.dirname(root); await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const stage = path.join(parent, `.runtime-${randomUUID()}`);
  onProgress('正在创建桥接和本机连接密钥');
  try {
    await fs.mkdir(path.join(stage, 'state'), { recursive: true, mode: 0o700 });
    await Promise.all(RUNTIME_FILES.map((file, index) => fs.writeFile(path.join(stage, file), sources[index], { mode: 0o600 })));
    await fs.writeFile(path.join(stage, 'settings.json'), JSON.stringify({ port, ...executables, webSearch: 'live' }, null, 2), { mode: 0o600 });
    await fs.writeFile(path.join(stage, 'state', 'local-key'), randomBytes(32).toString('hex'), { mode: 0o600 });
    await fs.writeFile(path.join(stage, 'installation.json'), JSON.stringify({ owner: 'dsh-plugin-codex-local-bridge', format: 1, createdAt: new Date().toISOString() }), { mode: 0o600 });
    // A previously empty target can be removed without recursive deletion.
    try { await fs.rmdir(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(stage, root);
    return { root, created: true };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
