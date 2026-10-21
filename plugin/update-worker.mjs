// This self-contained worker is copied outside the package before it updates that package.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const PACKAGE = 'dsh-plugin-codex-local-bridge';
const safe = error => String(error?.message || error).replace(/Bearer\s+\S+|[a-f0-9]{48,}/gi, '[隐藏密钥]').slice(0, 260);

export async function findGit({ env = process.env, home = env.USERPROFILE || '', run = execute } = {}) {
  const candidates = ['git', path.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'), path.join(env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'), path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'git', 'cmd', 'git.exe')];
  for (const file of candidates) {
    try {
      const { stdout } = await run(file, ['--version'], { windowsHide: true, timeout: 3000, env });
      if (/^git version /m.test(stdout)) return file;
    } catch {}
  }
  throw new Error('未找到 Git，请安装 Git for Windows 并重新打开 Harness 后重试');
}
export function installArguments(config, directory) {
  if (!/^[a-f0-9]{40}$/.test(config.commit) || !/^[\w.-]{1,100}$/.test(config.profileName)) throw new Error('更新任务参数无效');
  return ['--expose-internals', path.join(directory, 'install-cli.mjs'), 'plugin', '--profile', config.profileName, 'add', `https://github.com/TianSamsara/dsh_codex#${config.commit}`];
}
export async function runUpdate(jobFile, { gitFinder = findGit, invoke } = {}) {
  const config = JSON.parse(await fs.readFile(jobFile, 'utf8')), directory = path.dirname(jobFile);
  if (!/^[a-f0-9-]{36}$/.test(config.id) || path.basename(directory) !== config.id) throw new Error('更新任务标识无效');
  const statusFile = path.join(directory, 'status.json');
  const report = async (status, message) => {
    const temporary = statusFile + '.' + process.pid + '.tmp';
    await fs.writeFile(temporary, JSON.stringify({ id: config.id, status, message, pid: process.pid, hostPid: config.hostPid, version: config.version, updatedAt: Date.now() }), { mode: 0o600 }); await fs.rename(temporary, statusFile);
  };
  try {
    const args = installArguments(config, directory);
    await report('installing', '正在检测 Git 并备份插件安装配置');
    const git = await gitFinder();
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: config.dshHome, DSH_CODEX_INSTALL_RESOURCES: config.resources, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
    if (path.isAbsolute(git)) { env.PATH = path.dirname(git) + path.delimiter + (env.PATH || env.Path || ''); delete env.Path; }
    const count = Number(env.GIT_CONFIG_COUNT || 0);
    if (!Number.isInteger(count) || count < 0 || count > 100) throw new Error('Git 环境配置无效');
    env.GIT_CONFIG_COUNT = String(count + 2);
    env[`GIT_CONFIG_KEY_${count}`] = 'http.version'; env[`GIT_CONFIG_VALUE_${count}`] = 'HTTP/1.1';
    env[`GIT_CONFIG_KEY_${count + 1}`] = 'http.sslBackend'; env[`GIT_CONFIG_VALUE_${count + 1}`] = 'openssl';
    const backup = path.join(directory, 'backup'); await fs.mkdir(backup, { mode: 0o700 });
    for (const file of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml']) {
      try { await fs.copyFile(path.join(config.profileDir, file), path.join(backup, file)); await fs.chmod(path.join(backup, file), 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await report('installing', `正在从 GitHub 安装 ${config.version}（${config.commit.slice(0, 7)}）`);
    const run = invoke || (async (exe, argv, options) => {
      const out = await fs.open(path.join(directory, 'install.stdout.log'), 'w', 0o600), err = await fs.open(path.join(directory, 'install.stderr.log'), 'w', 0o600);
      try { return await new Promise((resolve, reject) => { const child = spawn(exe, argv, { ...options, stdio: ['ignore', out.fd, err.fd] }); child.once('error', reject); child.once('exit', code => resolve(code)); }); }
      finally { await out.close(); await err.close(); }
    });
    const code = await run(config.exe, args, { cwd: config.profileDir, env, windowsHide: true });
    if (code !== 0) throw new Error('Harness 更新命令失败，原生安装器会尝试回滚；可在插件管理页查看安装详情后重试');
    const manifest = JSON.parse(await fs.readFile(path.join(config.profileDir, 'node_modules', PACKAGE, 'package.json'), 'utf8'));
    const profile = JSON.parse(await fs.readFile(path.join(config.profileDir, 'package.json'), 'utf8'));
    if (manifest.name !== PACKAGE || manifest.version !== config.version || !profile.dependencies?.[PACKAGE] || !profile.dsh?.profile?.bundles?.includes(PACKAGE)) throw new Error('安装结果尚未确认，请在插件管理中检查当前版本');
    const lock = await fs.readFile(path.join(config.profileDir, 'pnpm-lock.yaml'), 'utf8');
    if (!lock.includes(`https://codeload.github.com/TianSamsara/dsh_codex/tar.gz/${config.commit}`)) throw new Error('安装后的提交标识不匹配，请重新检查更新');
    await report('success', `已安装 ${config.version}。请在当前任务结束后重启 Harness，载入新版插件`);
  } catch (error) { await report('error', safe(error)); }
  finally {
    const lock = path.join(path.dirname(directory), 'update.lock');
    try { if ((await fs.readFile(lock, 'utf8')) === config.id) await fs.unlink(lock); } catch {}
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runUpdate(process.argv[2]).catch(() => { process.exitCode = 1; });
}
