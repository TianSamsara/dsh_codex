import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { updateRuntime, runtimeNeedsUpdate, SOURCE_FILES } from '../runtime-update.mjs';
import { inspectRoot } from '../core.mjs';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-update-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'bridge'), dshHome = path.join(temp, '.dsh');
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  for (const file of [...SOURCE_FILES, 'Start-Bridge.ps1']) await fs.copyFile(path.join(sourceRoot, 'bridge', file), path.join(root, file));
  await fs.appendFile(path.join(root, 'server.mjs'), '\n// previous source');
  const settings = Buffer.from('{"port":17654,"node":"node.exe","codex":"codex.exe","custom":true}\n');
  const key = Buffer.from('a'.repeat(64) + '\n');
  await fs.writeFile(path.join(root, 'settings.json'), settings); await fs.writeFile(path.join(root, 'state', 'local-key'), key);
  const file = path.join(dshHome, 'storages', 'codex-local-bridge', 'connection.json'); await fs.mkdir(path.dirname(file), { recursive: true });
  const memory = { version: 1, root, fingerprint: (await inspectRoot(root)).fingerprint, model: 'test-model', effort: 'high', autoConnect: true, autoStart: false, makeDefault: false, extra: 'retain-me' };
  await fs.writeFile(file, JSON.stringify(memory));
  const apply = async () => { for (const name of SOURCE_FILES) await fs.copyFile(path.join(sourceRoot, 'bridge', name), path.join(root, name)); return { version: '1.1.1', backup: 'private-backup' }; };
  return { root, dshHome, file, memory, settings, key, apply, packageRoot: sourceRoot };
}
test('runtime update preserves key/settings bytes and latest preferences, refreshing only the source fingerprint', async t => {
  const f = await fixture(t); assert.equal(await runtimeNeedsUpdate(f.dshHome, sourceRoot), true);
  const latest = { ...f.memory, effort: 'low', model: 'new-choice' };
  const result = await updateRuntime({ ...f, bridgeRoot: f.root }, { apply: async options => { assert.equal(options.root, f.root); await f.apply(); await fs.writeFile(f.file, JSON.stringify(latest)); return { version: '1.1.1' }; } });
  assert.equal(result.updated, true);
  const saved = JSON.parse(await fs.readFile(f.file)); const fingerprint = saved.fingerprint; delete saved.fingerprint;
  const expected = { ...latest }; delete expected.fingerprint; assert.deepEqual(saved, expected);
  assert.notEqual(fingerprint, f.memory.fingerprint); assert.equal(fingerprint, (await inspectRoot(f.root)).fingerprint);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'settings.json')), f.settings); assert.deepEqual(await fs.readFile(path.join(f.root, 'state', 'local-key')), f.key);
  assert.equal(await runtimeNeedsUpdate(f.dshHome, sourceRoot), false);
});
test('failed updates leave connection memory untouched and cannot falsely confirm source replacement', async t => {
  const f = await fixture(t), before = await fs.readFile(f.file);
  await assert.rejects(updateRuntime({ ...f, bridgeRoot: f.root }, { apply: async () => { throw new Error('old source restored'); } }), /old source restored/);
  assert.deepEqual(await fs.readFile(f.file), before);
  await assert.rejects(updateRuntime({ ...f, bridgeRoot: f.root }, { apply: async () => ({ version: '1.1.1' }) }), /源码核对/);
  assert.deepEqual(await fs.readFile(f.file), before);
});
test('changing or forgetting the connection never resurrects stale preferences or approves a different directory', async t => {
  const f = await fixture(t);
  await assert.rejects(updateRuntime({ ...f, bridgeRoot: f.root }, { apply: async () => { await f.apply(); await fs.writeFile(f.file, JSON.stringify({ root: 'different', model: 'keep-new' })); return { version: '1.1.1' }; } }), /目录已改变/);
  assert.equal(JSON.parse(await fs.readFile(f.file)).model, 'keep-new');
  let called = false;
  await assert.rejects(updateRuntime({ ...f, bridgeRoot: f.root }, { apply: async () => { called = true; } }), /目录已改变/);
  assert.equal(called, false);
  assert.deepEqual(await updateRuntime({ dshHome: f.dshHome }), { skipped: true });
});
