import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RepositoryUpdater, PACKAGE, repositoryJSON, readRepository, installedCommit, compareVersions, atomicJSON } from '../updater.mjs';
import { runUpdate, installArguments, findGit } from '../update-worker.mjs';

const before = 'a'.repeat(40), latest = 'b'.repeat(40), secret = 'local-key-must-stay-private';
const lockText = commit => `importers:\n  .:\n    dependencies:\n      ${PACKAGE}:\n        specifier: github:TianSamsara/dsh_codex\n        version: https://codeload.github.com/TianSamsara/dsh_codex/tar.gz/${commit}\n`;
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-update-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dshHome = path.join(home, '.dsh'), profileDir = path.join(dshHome, 'profiles', 'desktop'), packageRoot = path.join(home, 'source');
  await fs.mkdir(packageRoot, { recursive: true }); await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: PACKAGE, version: '0.3.1' }));
  await fs.mkdir(path.join(profileDir, 'node_modules', PACKAGE), { recursive: true });
  await fs.writeFile(path.join(profileDir, 'node_modules', PACKAGE, 'package.json'), JSON.stringify({ name: PACKAGE, version: '0.3.1' }));
  await fs.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ dependencies: { [PACKAGE]: 'github:TianSamsara/dsh_codex', unrelated: 'link:somewhere' }, dsh: { profile: { bundles: [PACKAGE, 'unrelated'] } } }));
  await fs.writeFile(path.join(profileDir, 'pnpm-lock.yaml'), lockText(before));
  await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), secret);
  const calls = [], fetcher = async (url, options) => { calls.push({ url, options }); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, undefined);
    return new Response(JSON.stringify(url.includes('api.github.com') ? { sha: latest } : { name: PACKAGE, version: '0.3.2', dsh: { bundle: { patch: './plugin/cordis.patch.yml' } } })); };
  let launches = 0;
  const updater = new RepositoryUpdater({ dshHome, profileDir, packageRoot, fetcher, headReader: async () => { throw new Error('GitHub 暂时限制更新检查，请稍后重试'); },
    harness: async () => ({ exe: 'Harness.exe', resources: 'resources' }), launch: async () => { launches++; return process.pid; } });
  await updater.init();
  return { home, dshHome, profileDir, packageRoot, updater, calls, get launches() { return launches; } };
}

test('repository checks use a fixed repo and immutable commit manifest without sending local credentials', async t => {
  const f = await fixture(t), state = await f.updater.check();
  assert.equal(state.available, true); assert.equal(state.latestVersion, '0.3.2'); assert.equal(state.currentCommit, before);
  assert.equal(f.calls[1].url, `https://raw.githubusercontent.com/TianSamsara/dsh_codex/${latest}/package.json`);
  assert.equal(JSON.stringify(state).includes(secret), false);
  assert.equal(installedCommit(lockText(before)), before); assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
});

test('same version commit changes are detected; identical and older versions are retained', async t => {
  const f = await fixture(t);
  const check = async (version, commit) => { f.updater.fetcher = async url => new Response(JSON.stringify(url.includes('api.github.com') ? { sha: commit } : { name: PACKAGE, version, dsh: { bundle: { patch: 'patch' } } })); return f.updater.check(); };
  assert.equal((await check('0.3.1', latest)).available, true);
  assert.equal((await check('0.3.1', before)).available, false);
  assert.equal((await check('0.3.0', latest)).available, false);
});

test('GitHub API rate limits fall back to Git and still read an immutable manifest', async () => {
  const calls = [];
  const result = await readRepository(async url => { calls.push(url); return url.includes('api.github.com') ? new Response('{}', { status: 403 }) : new Response(JSON.stringify({ name: PACKAGE, version: '0.3.2', dsh: { bundle: { patch: 'patch' } } })); }, async () => latest);
  assert.equal(result.commit, latest); assert.equal(calls[1], `https://raw.githubusercontent.com/TianSamsara/dsh_codex/${latest}/package.json`);
});

test('rate limits, wrong packages and oversized responses fail without installing', async t => {
  const f = await fixture(t);
  f.updater.fetcher = async () => new Response('{}', { status: 403 });
  await assert.rejects(f.updater.check(), /限制更新检查/); assert.equal(f.launches, 0);
  await assert.rejects(readRepository(async url => new Response(JSON.stringify(url.includes('api.github.com') ? { sha: latest } : { name: 'foreign', version: '1.0.0' }))), /不是有效/);
  await assert.rejects(repositoryJSON('https://evil.example/package.json'), /不受支持/);
  await assert.rejects(repositoryJSON('https://api.github.com/test', async () => new Response('x'.repeat(100)), 10), /过大/);
});

test('update starts a detached worker with a checked commit and preserves connection files', async t => {
  const f = await fixture(t); await assert.rejects(f.updater.start(), /先检查/);
  await f.updater.check(); const state = await f.updater.start(); assert.equal(state.status, 'queued'); assert.equal(f.launches, 1);
  const directory = path.join(f.updater.directory, state.jobId), config = JSON.parse(await fs.readFile(path.join(directory, 'job.json'), 'utf8'));
  assert.equal(config.commit, latest); assert.equal(config.profileName, 'desktop');
  assert.ok(installArguments(config, directory).at(-1).endsWith('#' + latest));
  await assert.rejects(f.updater.start(), /正在更新/); assert.equal(f.launches, 1);
  assert.equal(await fs.readFile(path.join(f.profileDir, 'cordis.patch.yml'), 'utf8'), secret);
});

test('stale checks and local development links are not overwritten', async t => {
  const f = await fixture(t); await f.updater.check(); f.updater.state.checkedAt = Date.now() - 700000;
  await assert.rejects(f.updater.start(), /先检查/);
  await f.updater.check(); const manifest = JSON.parse(await fs.readFile(path.join(f.profileDir, 'package.json'), 'utf8')); manifest.dependencies[PACKAGE] = 'link:D:/project';
  await fs.writeFile(path.join(f.profileDir, 'package.json'), JSON.stringify(manifest));
  await assert.rejects(f.updater.start(), /本地开发链接/); assert.equal(f.launches, 0);
});

test('worker verifies installed version and commit, keeps backups, and releases its update lock', async t => {
  const f = await fixture(t); await f.updater.check(); const state = await f.updater.start(); const directory = path.join(f.updater.directory, state.jobId);
  await runUpdate(path.join(directory, 'job.json'), { gitFinder: async () => path.join(f.home, 'git.exe'), invoke: async (exe, argv, options) => {
    assert.equal(argv.at(-1), `https://github.com/TianSamsara/dsh_codex#${latest}`); assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1'); assert.equal(options.windowsHide, true);
    await fs.writeFile(path.join(f.profileDir, 'node_modules', PACKAGE, 'package.json'), JSON.stringify({ name: PACKAGE, version: '0.3.2' }));
    await fs.writeFile(path.join(f.profileDir, 'pnpm-lock.yaml'), lockText(latest)); return 0;
  } });
  const result = await f.updater.status(); assert.equal(result.status, 'success'); assert.equal(result.installedVersion, '0.3.2'); assert.equal(result.restartRequired, true);
  assert.equal(await fs.readFile(path.join(directory, 'backup', 'cordis.patch.yml'), 'utf8'), secret);
  assert.equal(JSON.stringify(result).includes(secret), false); await assert.rejects(fs.access(path.join(f.updater.directory, 'update.lock')));
  await f.updater.check(); assert.equal((await f.updater.status()).status, 'checked', 'old success must not hide a new check');
});

test('failed or crashed workers expose a bounded error and allow retrying', async t => {
  const f = await fixture(t); await f.updater.check(); const state = await f.updater.start(); const directory = path.join(f.updater.directory, state.jobId);
  await runUpdate(path.join(directory, 'job.json'), { gitFinder: async () => 'git', invoke: async () => 1 });
  assert.equal((await f.updater.status()).status, 'error'); await assert.rejects(fs.access(path.join(f.updater.directory, 'update.lock')));
  await atomicJSON(path.join(directory, 'status.json'), { id: state.jobId, status: 'installing', pid: 2147483647, updatedAt: Date.now() });
  await fs.writeFile(path.join(f.updater.directory, 'update.lock'), state.jobId);
  assert.equal((await f.updater.status()).status, 'error'); await assert.rejects(fs.access(path.join(f.updater.directory, 'update.lock')));
});

test('Git discovery uses an existing executable and never builds shell commands', async () => {
  let calls = 0;
  const file = await findGit({ env: {}, home: 'C:/fake', run: async (exe, argv, options) => { calls++; assert.deepEqual(argv, ['--version']); assert.equal(options.windowsHide, true); if (exe === 'git') throw new Error('missing'); return { stdout: 'git version 2.50.0' }; } });
  assert.notEqual(file, 'git'); assert.equal(calls, 2);
  assert.throws(() => installArguments({ commit: 'main; run something', profileName: 'desktop' }, '.'), /无效/);
});
