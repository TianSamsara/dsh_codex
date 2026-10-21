import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepareRuntime, findExecutables, managedRoot, RUNTIME_FILES } from '../bootstrap.mjs';
import { BridgeManager, inspectRoot } from '../core.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-auto-setup-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dshHome = path.join(home, '.dsh'), codex = path.join(home, 'codex.exe'); await fs.writeFile(codex, '');
  return { home, dshHome, codex, detect: async () => ({ codex, node: process.execPath, electronNode: true }), available: async port => port === 17656 };
}

test('first setup creates a complete private bridge, a unique key and an available port', async t => {
  const f = await fixture(t), progress = [];
  const result = await prepareRuntime({ ...f, onProgress: text => progress.push(text) });
  assert.equal(result.root, managedRoot(f.dshHome)); assert.equal(result.created, true);
  for (const file of RUNTIME_FILES) await fs.access(path.join(result.root, file));
  const settings = JSON.parse(await fs.readFile(path.join(result.root, 'settings.json'), 'utf8'));
  const key = await fs.readFile(path.join(result.root, 'state', 'local-key'), 'utf8');
  assert.equal(settings.port, 17656); assert.equal(settings.electronNode, true); assert.equal(settings.webSearch, 'live'); assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(key), false); assert.ok(progress.length >= 3);
  assert.equal((await inspectRoot(result.root)).key, key);
  const secondHome = path.join(f.home, 'second');
  const second = await prepareRuntime({ ...f, dshHome: secondHome });
  assert.notEqual(await fs.readFile(path.join(second.root, 'state', 'local-key'), 'utf8'), key);
});

test('repeated setup preserves the original key and settings without reinstalling', async t => {
  const f = await fixture(t), first = await prepareRuntime(f);
  const before = await fs.readFile(path.join(first.root, 'state', 'local-key'), 'utf8');
  const settings = await fs.readFile(path.join(first.root, 'settings.json'), 'utf8');
  const result = await prepareRuntime({ ...f, detect: async () => { throw new Error('Should not redetect'); } });
  assert.equal(result.created, false);
  assert.equal(await fs.readFile(path.join(first.root, 'state', 'local-key'), 'utf8'), before);
  assert.equal(await fs.readFile(path.join(first.root, 'settings.json'), 'utf8'), settings);
});

test('missing Codex, missing payload and occupied ports leave no half-installed runtime', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareRuntime({ ...f, detect: async () => { throw new Error('Codex missing'); } }), /Codex missing/);
  await assert.rejects(prepareRuntime({ ...f, bundleRoot: path.join(f.home, 'missing') }), /ENOENT/);
  await assert.rejects(prepareRuntime({ ...f, available: async () => false }), /端口均被占用/);
  await assert.rejects(fs.access(managedRoot(f.dshHome)));
});

test('unknown contents and damaged managed installations are preserved', async t => {
  const f = await fixture(t), root = managedRoot(f.dshHome); await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'keep.txt'), 'user data');
  await assert.rejects(prepareRuntime(f), /已有其他内容/);
  assert.equal(await fs.readFile(path.join(root, 'keep.txt'), 'utf8'), 'user data');
  await fs.writeFile(path.join(root, 'installation.json'), JSON.stringify({ owner: 'dsh-plugin-codex-local-bridge' }));
  await assert.rejects(prepareRuntime(f)); assert.equal(await fs.readFile(path.join(root, 'keep.txt'), 'utf8'), 'user data');
});

test('Codex detection locates desktop executables and supports the Harness Electron runtime', async t => {
  const f = await fixture(t), local = path.join(f.home, 'Local'), bin = path.join(local, 'OpenAI', 'Codex', 'bin', 'version');
  await fs.mkdir(bin, { recursive: true }); await fs.writeFile(path.join(bin, 'codex.exe'), '');
  const result = await findExecutables({ home: f.home, env: { LOCALAPPDATA: local }, execPath: process.execPath, versions: { node: '24.0.0', electron: '40' }, platform: 'win32' });
  assert.equal(result.codex, path.join(bin, 'codex.exe')); assert.equal(result.electronNode, true);
  await assert.rejects(findExecutables({ home: f.home, env: {}, platform: 'linux' }), /Windows/);
  await assert.rejects(findExecutables({ home: f.home, env: {}, versions: { node: '18.0.0' }, platform: 'win32' }), /运行时过旧/);
  await assert.rejects(findExecutables({ home: f.home, env: {}, platform: 'win32' }), /未找到本机 Codex/);
});

test('one-click setup initializes, starts, loads models and remembers, and then reuses that connection', async t => {
  const f = await fixture(t); let installed = 0, launched = 0, online = false, applied = 0;
  const manager = new BridgeManager({ home: f.home, dshHome: f.dshHome,
    initializer: options => { installed++; return prepareRuntime({ ...f, ...options }); },
    launcher: async () => { launched++; online = true; }, onConnected: async () => { applied++; },
    fetcher: async url => { if (!online) throw new Error('offline'); return new Response(JSON.stringify(url.pathname === '/health' ? { service: 'dsh-codex-bridge', version: '1.1.0' } : { data: [{ id: 'test', supportedReasoningEfforts: [] }] })); }
  });
  const state = await manager.autoSetup();
  assert.equal(state.phase, 'connected'); assert.equal(state.remembered, true); assert.equal(state.models[0].id, 'test');
  assert.equal(launched, 1); assert.equal(installed, 1); assert.equal(applied, 1);
  const key = (await inspectRoot(state.root)).key;
  await manager.autoSetup(); assert.equal(installed, 1); assert.equal(launched, 1); assert.equal(applied, 2);
  assert.equal((await inspectRoot(state.root)).key, key); assert.equal(JSON.stringify(manager.status()).includes(key), false);
  const loaded = new BridgeManager({ home: f.home, dshHome: f.dshHome }); await loaded.load();
  assert.equal(loaded.memory.root, state.root); assert.equal(loaded.memory.autoStart, true);
});

test('setup is exclusive and does not silently acknowledge changed native bridge modules', async t => {
  const f = await fixture(t), result = await prepareRuntime(f);
  const before = await inspectRoot(result.root); await fs.appendFile(path.join(result.root, 'manager.mjs'), '\n// changed\n');
  assert.notEqual((await inspectRoot(result.root)).fingerprint, before.fingerprint);
  const manager = new BridgeManager({ home: f.home, dshHome: f.dshHome }); manager.busy = true;
  await assert.rejects(manager.autoSetup(), /正在处理/);
});
