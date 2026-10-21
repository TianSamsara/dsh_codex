import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';

test('the Git repository root resolves as an installable Harness plugin', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const require = createRequire(new URL('package.json', root));
  assert.equal(manifest.name, 'dsh-plugin-codex-local-bridge');
  const nested = JSON.parse(await readFile(new URL('plugin/package.json', root), 'utf8'));
  assert.equal(manifest.version, nested.version);
  assert.notEqual(manifest.private, true);
  for (const entry of ['', '/client', '/package.json', '/cordis.patch.yml', '/locale/en.json', '/locale/zh.json']) await access(require.resolve(manifest.name + entry));
  await access(new URL(manifest.dsh.bundle.patch, root));
  const patch = await readFile(new URL(manifest.dsh.bundle.patch, root), 'utf8');
  assert.match(patch, new RegExp(`name: ${manifest.name}`));
  const client = await readFile(require.resolve(manifest.name + '/client'), 'utf8');
  assert.ok(client.includes(`id: '${manifest.name}'`));
});
