import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SOURCE_FILES } from '../plugin/runtime-update.mjs';

const execute = promisify(execFile), repo = fileURLToPath(new URL('../', import.meta.url));
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const native = { skip: process.platform !== 'win32', timeout: 90000 };
async function fixture(t, { busy = false, invalid = false, electron = false } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-native-update-'));
  const root = path.join(temp, 'runtime with spaces'), bundle = path.join(temp, 'bundle'), bridge = path.join(bundle, 'bridge');
  await fs.mkdir(path.join(root, 'state'), { recursive: true }); await fs.mkdir(bridge, { recursive: true });
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve)); const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  for (const name of SOURCE_FILES) { await fs.copyFile(path.join(repo, 'bridge', name), path.join(root, name)); await fs.copyFile(path.join(repo, 'bridge', name), path.join(bridge, name)); }
  await fs.copyFile(path.join(repo, 'Update-Bridge.ps1'), path.join(bundle, 'Update-Bridge.ps1'));
  await fs.writeFile(path.join(root, 'protocol.mjs'), (await fs.readFile(path.join(root, 'protocol.mjs'), 'utf8')).replace("VERSION = '1.1.1'", "VERSION = '1.1.0'"));
  if (busy) await fs.writeFile(path.join(root, 'server.mjs'), (await fs.readFile(path.join(root, 'server.mjs'), 'utf8')).replace('let active = 0', 'let active = 1'));
  if (invalid) await fs.writeFile(path.join(bridge, 'server.mjs'), invalid === 'hang' ? 'setInterval(() => {}, 1000);' : 'throw new Error("intentional startup failure");');
  const node = electron ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe') : process.execPath;
  const settings = JSON.stringify({ port, node, electronNode: electron, codex: 'unused-codex.exe', customSetting: 'preserved' }) + '\n', key = 'c'.repeat(64) + '\n';
  await fs.writeFile(path.join(root, 'settings.json'), settings); await fs.writeFile(path.join(root, 'state', 'local-key'), key);
  const headers = { Authorization: `Bearer ${key.trim()}` }, url = `http://127.0.0.1:${port}/health`;
  const health = async () => (await fetch(url, { headers, signal: AbortSignal.timeout(1000) })).json();
  const child = spawn(node, [path.join(root, 'server.mjs')], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } });
  t.after(async () => {
    const scriptPath = path.join(root, 'server.mjs').replaceAll("'", "''");
    // Only processes whose full command line includes this unique test server can be stopped.
    await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', `$env:PSModulePath = Join-Path $PSHOME 'Modules'; $p = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','DeepSeek Harness.exe') -and $_.CommandLine.Contains('${scriptPath}') }; foreach ($item in $p) { & "$env:SystemRoot\\System32\\taskkill.exe" /PID $item.ProcessId /T /F | Out-Null }`], { windowsHide: true });
    await delay(150); await fs.rm(temp, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 40; i++) { try { if ((await health()).version === '1.1.0') { ready = true; break; } } catch {} await delay(100); }
  assert.equal(ready, true, 'isolated old bridge starts');
  const run = async () => {
    const resultFile = path.join(root, 'state', 'update-result.json');
    const code = await new Promise((resolve, reject) => { const process = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(bundle, 'Update-Bridge.ps1'), '-BridgeRoot', root, '-WaitSeconds', '0', '-ResultFile', resultFile], { windowsHide: true, stdio: 'ignore' }); process.once('exit', resolve); process.once('error', reject); });
    const result = await fs.readFile(resultFile, 'utf8');
    if (code !== 0) throw Object.assign(new Error(JSON.parse(result).error), { stderr: JSON.parse(result).error });
    return { stdout: result };
  };
  const preserved = async () => { assert.equal(await fs.readFile(path.join(root, 'settings.json'), 'utf8'), settings); assert.equal(await fs.readFile(path.join(root, 'state', 'local-key'), 'utf8'), key); };
  return { root, child, health, run, preserved };
}
test('Windows replaces a running bridge and preserves key/configuration with an Electron runtime', native, async t => {
  const f = await fixture(t, { electron: true }); const result = JSON.parse((await f.run()).stdout.trim());
  assert.equal(result.version, '1.1.1'); assert.equal((await f.health()).version, '1.1.1'); await f.preserved();
  assert.equal((await fs.readFile(path.join(result.backup, 'protocol.mjs'), 'utf8')).includes("VERSION = '1.1.0'"), true);
});
test('Windows busy timeout keeps old source accepting requests without draining', native, async t => {
  const f = await fixture(t, { busy: true }); const before = await fs.readFile(path.join(f.root, 'server.mjs'));
  await assert.rejects(f.run(), error => /active requests/.test(error.stderr));
  assert.deepEqual(await fs.readFile(path.join(f.root, 'server.mjs')), before); const health = await f.health(); assert.equal(health.version, '1.1.0'); assert.equal(health.draining, false); await f.preserved();
});
test('Windows failed startup restores and restarts the previous bridge', native, async t => {
  const f = await fixture(t, { invalid: true }); const before = await fs.readFile(path.join(f.root, 'server.mjs'));
  await assert.rejects(f.run(), error => /Previous source restored/.test(error.stderr));
  assert.deepEqual(await fs.readFile(path.join(f.root, 'server.mjs')), before); assert.equal((await f.health()).version, '1.1.0'); await f.preserved();
});
test('Windows hung startup without a listener is stopped before restoring the previous bridge', native, async t => {
  const f = await fixture(t, { invalid: 'hang' });
  await assert.rejects(f.run(), error => /Previous source restored/.test(error.stderr));
  assert.equal((await f.health()).version, '1.1.0'); await f.preserved();
});
