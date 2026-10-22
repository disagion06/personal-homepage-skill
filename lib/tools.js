'use strict';
/**
 * 工具与插件的检测 / 自动安装。
 *
 * 需求里「用户选择隐藏的同时，自动装好所需的插件」就是这一层：
 *   - Git        ：没有就用 winget 装（装不上给出明确指引）
 *   - GitHub CLI ：优先用系统已装的，没有就自动下载官方 zip 解压到程序工作目录（无需管理员权限）
 *   - sharp      ：图片打码插件，用 npm 装到工作目录；装不上则自动降级为占位图
 *   - GitHub 登录：弹出真实终端窗口让用户自己授权，程序只负责轮询登录状态
 */
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { run, which, netCheck, openTerminal, sleep, fetchWithRetry, quoteWin } = require('./shell');
const { ensureDir, humanBytes, rmrf } = require('./util');
const images = require('./images');

const GH_RELEASE_API = 'https://api.github.com/repos/cli/cli/releases/latest';
const GH_COMMON = [
  'C:\\Program Files\\GitHub CLI\\gh.exe',
  'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
  path.join(process.env.LOCALAPPDATA || '', 'GitHubCLI', 'gh.exe'),
  '/usr/local/bin/gh',
  '/opt/homebrew/bin/gh',
  '/usr/bin/gh'
];

function toolsPaths(toolsDir) {
  const base = toolsDir || path.join(process.env.APPDATA || process.env.HOME || '.', 'design-deployer-tools');
  return {
    base,
    ghDir: path.join(base, 'gh'),
    ghExe: path.join(base, 'gh', 'bin', 'gh.exe'),
    ghExeAlt: path.join(base, 'gh', 'gh.exe'),
    npmCache: path.join(base, 'npm-cache')
  };
}

/** 找到 gh 可执行文件 */
async function findGh(toolsDir) {
  const p = toolsPaths(toolsDir);
  for (const cand of [p.ghExe, p.ghExeAlt]) {
    try {
      if (fs.existsSync(cand)) return cand;
    } catch {}
  }
  // 解压后目录结构可能是 gh_2.x.x_windows_amd64/bin/gh.exe
  try {
    const entries = await fsp.readdir(p.ghDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        for (const sub of ['bin/gh.exe', 'gh.exe']) {
          const f = path.join(p.ghDir, e.name, ...sub.split('/'));
          if (fs.existsSync(f)) return f;
        }
      }
    }
  } catch {}
  const sys = which('gh') || GH_COMMON.find((f) => f && fs.existsSync(f));
  return sys || null;
}

function findGit() {
  return which('git') || (process.platform === 'win32' ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe'].find((f) => fs.existsSync(f)) || null : null);
}

function findNpm() {
  return which('npm') || which('npm.cmd');
}

async function versionOf(exe, args = ['--version'], opts = {}) {
  const r = await run(exe, args, { timeoutMs: 20000, ...opts });
  if (!r.ok) return null;
  const out = (r.stdout || r.stderr || '').trim().split(/\r?\n/)[0];
  return out.replace(/^v/i, '').slice(0, 40) || null;
}

/* --------------------------------------------------------------- 状态 */

/**
 * 汇总当前环境状态。任何一步失败都不抛异常，只把 ok 置为 false。
 * @returns {Promise<object>} ToolsStatus（见 docs/IPC_CONTRACT.md §5）
 */
async function status({ toolsDir, sharpDir, onLog } = {}) {
  const out = {
    node: { ok: true, version: process.versions.node },
    npm: { ok: false, version: null, path: null },
    git: { ok: false, version: null, path: null },
    gh: { ok: false, version: null, path: null, source: null, installing: false },
    auth: { loggedIn: false, user: null, scopes: [], host: 'github.com', protocol: 'https' },
    sharp: { ok: false, version: null, installing: false, error: null },
    net: { ok: false, checkedAt: new Date().toISOString() }
  };

  const npm = findNpm();
  if (npm) {
    out.npm.path = npm;
    out.npm.version = await versionOf(npm, ['--version'], { shell: /\.cmd$/i.test(npm) });
    out.npm.ok = !!out.npm.version;
  }

  const git = findGit();
  if (git) {
    out.git.path = git;
    out.git.version = await versionOf(git, ['--version']);
    out.git.ok = !!out.git.version;
  }

  const gh = await findGh(toolsDir);
  if (gh) {
    out.gh.path = gh;
    out.gh.version = await versionOf(gh, ['--version']);
    out.gh.ok = !!out.gh.version;
    out.gh.source = gh.startsWith(toolsPaths(toolsDir).base) ? 'bundled' : 'system';
    if (out.gh.ok) {
      const st = await run(gh, ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 20000 });
      const text = (st.stdout || '') + (st.stderr || '');
      const m = /Logged in to github\.com account ([^\s]+)/i.exec(text) || /account\s+([A-Za-z0-9-]+)/i.exec(text);
      const scopes = /Token scopes:\s*'([^']+)'/.exec(text);
      if (st.code === 0 && m) {
        out.auth.loggedIn = true;
        out.auth.user = m[1].replace(/[^\w-]/g, '');
        out.auth.scopes = scopes ? scopes[1].split(/',\s*'/).map((s) => s.replace(/'/g, '')) : [];
      }
    }
  }

  // sharp：优先程序目录，其次工作目录
  const sharp = images.loadSharp(sharpDir || toolsDir);
  if (sharp) {
    try {
      const pkg = require(path.join(sharpDir || toolsDir || '.', 'node_modules', 'sharp', 'package.json'));
      out.sharp.version = pkg.version;
    } catch {
      out.sharp.version = '已加载';
    }
    out.sharp.ok = true;
  }

  try {
    const net = await netCheck('https://api.github.com/', 6000);
    out.net.ok = !!net.ok;
  } catch {
    out.net.ok = false;
  }

  return out;
}

/* --------------------------------------------------------------- 安装 */

async function installGh(toolsDir, { onLog, onProgress } = {}) {
  const p = toolsPaths(toolsDir);
  await ensureDir(p.ghDir);
  onLog('info', '正在获取 GitHub CLI 最新版本信息…');
  const res = await fetchWithRetry(GH_RELEASE_API, { headers: { Accept: 'application/vnd.github+json' }, retries: 2 });
  if (!res.ok) throw new Error('无法访问 GitHub API（HTTP ' + res.status + '），请检查网络或代理');
  const rel = await res.json();
  const assets = rel.assets || [];
  const isArm = process.arch === 'arm64';
  const want = process.platform === 'win32' ? (isArm ? /windows_arm64\.zip$/i : /windows_amd64\.zip$/i) : /linux_amd64\.tar\.gz$/i;
  const asset = assets.find((a) => want.test(a.name));
  if (!asset) throw new Error('没有找到适配当前系统的 gh 安装包：' + assets.map((a) => a.name).join(', '));

  const zipPath = path.join(p.base, asset.name);
  onLog('info', '正在下载 ' + asset.name + '（' + humanBytes(asset.size) + '）…');
  const dl = await fetchWithRetry(asset.browser_download_url, { retries: 2, timeoutMs: 600000 });
  if (!dl.ok) throw new Error('下载失败：HTTP ' + dl.status);
  await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(zipPath));
  const st = await fsp.stat(zipPath);
  onLog('ok', '下载完成：' + humanBytes(st.size));

  onProgress && onProgress(70, '解压 GitHub CLI…');
  const tar = which('tar') || (process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar');
  if (tar && fs.existsSync(tar)) {
    const r = await run(tar, ['-xf', zipPath, '-C', p.ghDir], { timeoutMs: 180000, shell: false });
    if (!r.ok) onLog('warn', 'tar 解压失败：' + (r.output || r.error));
  }
  if (!(await findGh(toolsDir))) {
    // 回退到 PowerShell
    const ps = 'Expand-Archive -LiteralPath ' + JSON.stringify(zipPath) + ' -DestinationPath ' + JSON.stringify(p.ghDir) + ' -Force';
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 240000 });
    if (!r.ok) throw new Error('解压失败：' + (r.output || r.error || '未知错误'));
  }
  await fsp.rm(zipPath, { force: true });
  const exe = await findGh(toolsDir);
  if (!exe) throw new Error('解压后仍未找到 gh 可执行文件');
  onLog('ok', 'GitHub CLI 已安装到 ' + exe);
  return exe;
}

async function installGitWithWinget({ onLog } = {}) {
  const winget = which('winget');
  if (!winget) throw new Error('未找到 winget，请手动安装 Git：https://git-scm.com/download/win');
  onLog('info', '正在通过 winget 安装 Git（可能需要几分钟）…');
  const r = await run(
    winget,
    ['install', '--id', 'Git.Git', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'],
    { timeoutMs: 600000, onLine: (l) => l.trim() && onLog('info', 'winget: ' + l.trim()) }
  );
  if (!r.ok) throw new Error('winget 安装 Git 失败：' + (r.output || r.error || '未知错误'));
  onLog('ok', 'Git 安装完成（可能需要重新打开程序才能生效）');
  return findGit();
}

async function installSharp(toolsDir, { onLog, onProgress, npmPath } = {}) {
  const p = toolsPaths(toolsDir);
  const npm = npmPath || findNpm();
  if (!npm) {
    throw new Error('未检测到 npm，无法自动安装图片打码插件（会改用占位图方案）');
  }
  await ensureDir(p.base);
  await ensureDir(p.npmCache);
  onLog('info', '正在安装图片打码插件 sharp（首次约 20~60 秒）…');
  const r = await run(
    npm,
    ['install', 'sharp', '--prefix', p.base, '--no-audit', '--no-fund', '--loglevel', 'error', '--cache', p.npmCache],
    {
      shell: /\.cmd$/i.test(npm),
      timeoutMs: 900000,
      onLine: (l) => {
        const t = l.trim();
        if (t) onLog('info', 'npm: ' + t.slice(0, 200));
      }
    }
  );
  if (!r.ok) throw new Error('sharp 安装失败：' + (r.output || r.error || '未知错误').slice(0, 300));
  images.resetSharpCache();
  const sharp = images.loadSharp(p.base);
  if (!sharp) throw new Error('sharp 安装完成但无法加载');
  onLog('ok', '图片打码插件 sharp 已就绪（照片将做真正的高斯模糊）');
  return true;
}

/**
 * 幂等地把所有需要的东西准备好。已经有的不会重复安装。
 * @returns {Promise<{ok:boolean, installed:string[], failed:Array, tools:object}>}
 */
async function setup({ toolsDir, onLog = () => {}, onProgress = () => {}, wantSharp = true } = {}) {
  const installed = [];
  const failed = [];

  onProgress(10, '检查运行环境…');
  let st = await status({ toolsDir, onLog });

  // 1) Git
  if (!st.git.ok) {
    onLog('warn', '未检测到 Git，尝试自动安装…');
    try {
      await installGitWithWinget({ onLog });
      installed.push('git');
    } catch (e) {
      failed.push({ name: 'git', error: e.message });
      onLog('error', e.message);
    }
  } else {
    onLog('ok', 'Git 已就绪：' + st.git.version);
  }

  // 2) GitHub CLI
  if (!st.gh.ok) {
    onProgress(35, '安装 GitHub CLI…');
    try {
      await installGh(toolsDir, { onLog, onProgress });
      installed.push('gh');
    } catch (e) {
      failed.push({ name: 'gh', error: e.message });
      onLog('error', '自动安装 GitHub CLI 失败：' + e.message);
      onLog('info', '也可以手动安装：https://cli.github.com/');
    }
  } else {
    onLog('ok', 'GitHub CLI 已就绪：' + st.gh.version + '（' + st.gh.source + '）');
  }

  // 3) sharp（图片打码插件）
  st = await status({ toolsDir, onLog });
  if (wantSharp && !st.sharp.ok) {
    onProgress(60, '安装图片打码插件…');
    try {
      await installSharp(toolsDir, { onLog, onProgress });
      installed.push('sharp');
    } catch (e) {
      failed.push({ name: 'sharp', error: e.message });
      onLog('warn', '图片打码插件不可用（' + e.message + '），将使用占位图方案替代');
    }
  }

  onProgress(100, '环境准备完成');
  const final = await status({ toolsDir, onLog });
  return { ok: final.git.ok && final.gh.ok, installed, failed, tools: final };
}

/* --------------------------------------------------------------- 登录 */

/**
 * 打开真实终端让用户自己完成 GitHub 授权，然后轮询登录状态。
 */
async function loginGithub({ toolsDir, onLog = () => {}, onProgress = () => {}, timeoutMs = 300000 } = {}) {
  const gh = await findGh(toolsDir);
  if (!gh) {
    return { ok: false, error: { code: 'E_NO_GH', message: '未找到 GitHub CLI，请先执行环境准备（自动安装插件）', tip: '点击界面上的「安装插件」按钮，或手动安装 https://cli.github.com/' } };
  }
  const st = await status({ toolsDir });
  if (st.auth.loggedIn) {
    return { ok: true, user: st.auth.user, already: true };
  }

  const cmdline = quoteWin(gh) + ' auth login --hostname github.com --git-protocol https --web';
  onLog('info', '已弹出终端窗口，请在浏览器中完成 GitHub 授权…');
  onLog('cmd', 'gh auth login --hostname github.com --git-protocol https --web');
  const opened = openTerminal(cmdline, { title: 'GitHub 登录 · 设计稿上线助手' });
  if (!opened.ok) {
    return { ok: false, error: { code: 'E_UNKNOWN', message: '无法打开终端窗口，请手动在命令行执行：gh auth login' } };
  }

  const started = Date.now();
  let lastTip = 0;
  while (Date.now() - started < timeoutMs) {
    await sleep(2500);
    const cur = await status({ toolsDir });
    const elapsed = Math.round((Date.now() - started) / 1000);
    onProgress(Math.min(95, Math.round((elapsed / (timeoutMs / 1000)) * 100)), '等待授权完成…（已等待 ' + elapsed + ' 秒）');
    if (cur.auth.loggedIn) {
      onLog('ok', '登录成功：' + cur.auth.user);
      return { ok: true, user: cur.auth.user, scopes: cur.auth.scopes };
    }
    if (Date.now() - lastTip > 30000) {
      lastTip = Date.now();
      onLog('info', '仍在等待授权…如果终端窗口已关闭，可以重新点「登录 GitHub」');
    }
  }
  return { ok: false, error: { code: 'E_NOT_LOGGED_IN', message: '等待授权超时（5 分钟）', tip: '可以重新点击「登录 GitHub 账号」再试一次' } };
}

/** 备用：用个人访问令牌登录 */
async function loginWithToken(token, { toolsDir, onLog = () => {} } = {}) {
  const gh = await findGh(toolsDir);
  if (!gh) return { ok: false, error: { code: 'E_NO_GH', message: '未找到 GitHub CLI' } };
  const t = String(token || '').trim();
  if (!t) return { ok: false, error: { code: 'E_BAD_INPUT', message: '令牌为空' } };
  const tmp = path.join(require('os').tmpdir(), 'dd-gh-token-' + Date.now() + '.txt');
  try {
    await fsp.writeFile(tmp, t, 'utf8');
    const r = await run(gh, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--with-token'], {
      stdinFile: tmp,
      timeoutMs: 60000
    });
    if (!r.ok) {
      return { ok: false, error: { code: 'E_AUTH', message: '令牌登录失败：' + (r.output || r.error || '').slice(0, 200), tip: '请确认令牌至少有 repo 权限' } };
    }
    const st = await status({ toolsDir });
    if (!st.auth.loggedIn) return { ok: false, error: { code: 'E_AUTH', message: '令牌已提交但未能确认登录状态' } };
    onLog('ok', '已使用访问令牌登录：' + st.auth.user);
    return { ok: true, user: st.auth.user, scopes: st.auth.scopes };
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

module.exports = {
  status,
  setup,
  installGh,
  installSharp,
  installGitWithWinget,
  loginGithub,
  loginWithToken,
  findGh,
  findGit,
  findNpm,
  toolsPaths
};
