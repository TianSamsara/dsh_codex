import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inspectRoot } from './core.mjs';

export const SOURCE_FILES = ['server.mjs', 'client.mjs', 'manager.mjs', 'protocol.mjs'];
const readJSON = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const memoryPath = home => path.join(home, 'storages', 'codex-local-bridge', 'connection.json');
export async function runtimeNeedsUpdate(dshHome, packageRoot) {
  let memory;
  try { memory = await readJSON(memoryPath(dshHome)); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!memory.root) return false;
  for (const file of SOURCE_FILES) {
    const source = await fs.readFile(path.join(packageRoot, 'bridge', file));
    try { if (!source.equals(await fs.readFile(path.join(memory.root, file)))) return true; }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }
  return false;
}
async function updateWindows({ root, packageRoot }) {
  if (process.platform !== 'win32') throw new Error('桥接自动更新目前支持 Windows');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const resultFile = path.join(root, 'state', `update-result-${randomUUID()}.json`);
  try {
    // No inherited pipes: a detached Windows bridge must not keep the updater waiting for EOF.
    const code = await new Promise((resolve, reject) => {
      const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(packageRoot, 'Update-Bridge.ps1'), '-BridgeRoot', root, '-ResultFile', resultFile], { windowsHide: true, stdio: 'ignore' });
      child.once('error', reject); child.once('exit', resolve);
    });
    let result; try { result = await readJSON(resultFile); } catch { throw new Error('桥接更新未返回结果，请检查桥接日志后重试'); }
    if (code !== 0 || result.error) throw new Error(result.error || '桥接更新未完成，密钥和设置未被覆盖');
    return result;
  } finally { await fs.rm(resultFile, { force: true }); }
}
export async function updateRuntime({ dshHome, bridgeRoot, packageRoot = fileURLToPath(new URL('../', import.meta.url)), report = async () => {} }, { apply = updateWindows } = {}) {
  if (!bridgeRoot) return { skipped: true };
  const file = memoryPath(dshHome), memory = await readJSON(file);
  const candidate = await inspectRoot(bridgeRoot);
  if (memory.root !== candidate.root) throw new Error('连接目录已改变，请重新检查更新');
  const protectedFiles = ['settings.json', path.join('state', 'local-key')];
  const snapshots = await Promise.all(protectedFiles.map(name => fs.readFile(path.join(candidate.root, name))));
  await report('installing', '插件已安装，正在等待桥接请求结束并更新本地桥接；密钥和设置保留');
  const result = await apply({ root: candidate.root, packageRoot });
  for (let i = 0; i < protectedFiles.length; i++) {
    if (!snapshots[i].equals(await fs.readFile(path.join(candidate.root, protectedFiles[i])))) throw new Error('更新期间桥接配置发生变化，请重新连接确认');
  }
  for (const name of SOURCE_FILES) {
    if (!(await fs.readFile(path.join(packageRoot, 'bridge', name))).equals(await fs.readFile(path.join(candidate.root, name)))) throw new Error('桥接源码核对未通过，请重新更新');
  }
  const updated = await inspectRoot(candidate.root);
  // Re-read preferences after installing; never restore a stale model or effort.
  const latest = await readJSON(file);
  if (latest.root !== candidate.root) throw new Error('连接目录已改变，桥接已更新，请重新连接新目录');
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temporary, JSON.stringify({ ...latest, fingerprint: updated.fingerprint }, null, 2), { mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
  return { updated: true, version: result.version, backup: result.backup };
}
