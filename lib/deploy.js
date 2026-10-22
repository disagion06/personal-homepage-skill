'use strict';
/**
 * 上线到 GitHub Pages：建库 → 推送 → 开启 Pages → 强制 HTTPS → 复核线上页面。
 *
 * 用户只需要自己做一件事：登录 GitHub 账号（在真实终端里走浏览器授权，程序代劳其余全部命令）。
 */
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const { run, sleep, fetchWithRetry } = require('./shell');
const tools = require('./tools');
const { slugify, humanBytes, nowIso, softMask } = require('./util');

const GIT_TIMEOUT = 900000; // 大站点首次推送可能要几分钟
const PAGES_POLL_MS = 6000;
const PAGES_TIMEOUT_MS = 420000;

function err(code, message, tip, detail) {
  return { ok: false, error: { code, message, tip, detail } };
}

async function ghApi(gh, args, opts = {}) {
  const r = await run(gh, ['api', ...args], { timeoutMs: opts.timeoutMs || 60000, ...opts });
  let json = null;
  const text = (r.stdout || '').trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { ...r, json, notFound: /HTTP 404|Not Found/i.test(r.stderr || r.stdout || '') };
}

/**
 * @param {object} opts
 * @param {string} opts.dir 生成好的站点目录（会被 git init）
 * @param {string} opts.repoName
 * @param {'project'|'user'} [opts.siteType]
 * @param {'public'|'private'} [opts.visibility]
 * @param {string} [opts.description]
 * @param {boolean} [opts.reuse] 仓库已存在时是否覆盖推送
 * @param {string} [opts.commitMessage]
 * @param {string} [opts.toolsDir]
 * @param {string[]} [opts.forbiddenValues] 线上若出现这些值就算复核失败
 * @param {string} [opts.reportPath] 脱敏报告路径（用于追加链接）
 * @param {(level,msg)=>void} [opts.onLog]
 * @param {(percent,label)=>void} [opts.onProgress]
 */
async function deploy(opts = {}) {
  const onLog = opts.onLog || (() => {});
  const onProgress = opts.onProgress || (() => {});
  const started = Date.now();
  const warnings = [];

  /* ---------- 0. 前置检查 ---------- */
  const dir = path.resolve(opts.dir || '');
  const st = await fsp.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) return err('E_NOT_FOUND', '要上线的目录不存在：' + dir);
  const git = tools.findGit();
  if (!git) return err('E_GIT', '未找到 Git，无法上线', '点击「安装插件」自动安装 Git，或从 https://git-scm.com 手动安装');
  const gh = await tools.findGh(opts.toolsDir);
  if (!gh) return err('E_NO_GH', '未找到 GitHub CLI', '点击「安装插件」自动安装，或从 https://cli.github.com 手动安装');

  const auth = await tools.status({ toolsDir: opts.toolsDir });
  if (!auth.auth.loggedIn) {
    return err('E_NOT_LOGGED_IN', '尚未登录 GitHub 账号', '点击「登录 GitHub 账号」完成浏览器授权');
  }
  const owner = auth.auth.user;
  const siteType = opts.siteType === 'user' ? 'user' : 'project';

  /* ---------- 0.1 待复核的原值：优先用调用方给的，否则读脱敏清单 ---------- */
  let forbidden = (opts.forbiddenValues || []).filter(Boolean);
  if (!forbidden.length) {
    const manifest = path.join(path.dirname(dir), path.basename(dir) + '-脱敏清单.json');
    try {
      const raw = JSON.parse(await fsp.readFile(manifest, 'utf8'));
      if (Array.isArray(raw.forbiddenValues)) {
        forbidden = raw.forbiddenValues.filter(Boolean);
        onLog('info', '已从脱敏清单读取 ' + forbidden.length + ' 个待复核的原值：' + manifest);
      }
    } catch {
      onLog('info', '没有找到脱敏清单（' + manifest + '），本次上线只验证链接可访问性');
    }
  }
  let repo = repoName(opts.repoName, siteType, owner);
  if (siteType === 'user' && repo.toLowerCase() !== owner.toLowerCase() + '.github.io') {
    repo = owner.toLowerCase() + '.github.io';
    warnings.push('用户站点要求仓库名必须是 ' + repo + '，已自动修正。');
  }
  const visibility = opts.visibility === 'private' ? 'private' : 'public';
  if (visibility === 'private') {
    warnings.push('私有仓库使用 GitHub Pages 需要付费账号（Pro/Team），免费账号构建会失败，建议选公开。');
  }
  onLog('info', '账号 ' + owner + ' · 目标仓库 ' + owner + '/' + repo + '（' + visibility + '）');

  /* ---------- 1. 仓库是否已存在 ---------- */
  onProgress(5, '检查仓库是否已存在…');
  const view = await ghApi(gh, ['repos/' + owner + '/' + repo, '--jq', '.full_name']);
  const exists = !view.notFound && view.code === 0;
  if (exists && !opts.reuse) {
    return err('E_REPO_EXISTS', '仓库 ' + owner + '/' + repo + ' 已经存在', '可以选择「覆盖推送」把新版本推上去，或者换一个仓库名', { repo: owner + '/' + repo });
  }

  /* ---------- 2. git init / commit ---------- */
  onProgress(12, '初始化本地仓库…');
  const runGit = (args, o = {}) =>
    run(git, args, {
      cwd: dir,
      timeoutMs: GIT_TIMEOUT,
      env: { GIT_TERMINAL_PROMPT: '0' },
      onLine: o.onLine,
      ...o
    });

  /**
   * 带凭据兜底的 git 调用。
   *
   * 正常情况下 git 会用系统凭据助手（Windows 上是 Git Credential Manager）
   * 或 gh 注册的助手；但在公司电脑、受限账号、凭据库被策略禁用等环境下，
   * 常见 `schannel: AcquireCredentialsHandle failed` / `could not read Username` 这类失败。
   * 这时退回到「用 gh 自己的令牌做一次带 Authorization 头的推送」：
   * 令牌只存在于本次子进程的参数里，不写进任何配置文件。
   */
  /**
   * 带兜底的 git 调用。按「默认 → 换 TLS 后端 → 追加令牌」的顺序重试。
   *
   * 为什么需要：
   *   - 有的机器上 git 的 schannel（Windows 自带 TLS）拿不到凭据句柄，报
   *     `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`，
   *     但同一台机器的 OpenSSL 后端完全正常（Git for Windows 两个后端都带）；
   *   - 系统凭据助手被策略禁用 / 用户从未存过密码时，会报
   *     `could not read Username` 或 `Authentication failed`；
   *   - 这时退回「用 gh 自己的令牌加一个 Authorization 请求头」最稳，
   *     令牌只存在于本次子进程的参数里，不写进任何配置文件。
   */
  const TLS_HINT = /schannel|AcquireCredentialsHandle|SEC_E_|SSL certificate problem|TLS/i;
  const CRED_HINTS = /could not read Username|Authentication failed|AcquireCredentialsHandle|terminal prompts disabled|Invalid username or password|403|401/i;

  async function runGitAuthed(args, o = {}) {
    const base = { cwd: dir, timeoutMs: GIT_TIMEOUT, env: { GIT_TERMINAL_PROMPT: '0' }, onLine: o.onLine };
    const first = await runGit(args, o);
    if (first.ok) return first;

    const output = first.output || '';
    const tlsIssue = TLS_HINT.test(output);
    if (!tlsIssue && !CRED_HINTS.test(output)) return first; // 与凭据/TLS 无关（例如非快进），不宜重试

    let token = null;
    const getToken = async () => {
      if (token !== null) return token;
      const t = await run(gh, ['auth', 'token', '--hostname', 'github.com'], { timeoutMs: 30000 });
      token = t.ok ? (t.stdout || '').trim() : '';
      if (!token) onLog('error', '拿不到 gh 令牌：' + (t.output || t.error || '').slice(0, 200));
      return token;
    };

    const attempts = [];
    if (tlsIssue) attempts.push({ label: 'OpenSSL TLS 后端', prefix: ['-c', 'http.sslBackend=openssl'], token: false });
    attempts.push({ label: 'GitHub CLI 令牌', prefix: [], token: true });
    if (tlsIssue) attempts.push({ label: 'OpenSSL 后端 + GitHub CLI 令牌', prefix: ['-c', 'http.sslBackend=openssl'], token: true });

    let last = first;
    for (const at of attempts) {
      const prefix = at.prefix.slice();
      if (at.token) {
        const tk = await getToken();
        if (!tk) continue;
        const header = 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + tk, 'utf8').toString('base64');
        prefix.push('-c', 'http.extraheader=' + header);
      }
      onLog('warn', 'git 操作失败（' + output.split('\n')[0].slice(0, 120) + '），改用「' + at.label + '」重试…');
      const r = await run(git, [...prefix, ...args], base);
      if (r.ok) {
        onLog('ok', '已改用「' + at.label + '」完成 git 操作');
        return r;
      }
      last = r;
    }
    return last;
  }

  const hasGit = fs.existsSync(path.join(dir, '.git'));
  if (!hasGit) {
    const init = await runGit(['init', '-b', 'main']);
    if (!init.ok) {
      const init2 = await runGit(['init']);
      if (!init2.ok) return err('E_GIT', 'git init 失败：' + (init2.output || init2.error));
      await runGit(['checkout', '-b', 'main']);
    }
    onLog('ok', '已初始化本地 git 仓库（分支 main）');
  } else {
    onLog('info', '目录里已有 .git，直接复用');
  }

  if (fs.existsSync(path.join(dir, '.gitignore'))) {
    warnings.push('站点目录里存在 .gitignore，被它排除的文件不会被推送到 GitHub。');
  }

  const identityName = owner;
  const identityEmail = auth.auth.user + '@users.noreply.github.com';
  await runGit(['add', '-A']);
  const commitMsg = opts.commitMessage || 'chore: 上线个人设计网站（由设计稿上线助手生成）';
  const commit = await runGit([
    '-c',
    'user.name=' + identityName,
    '-c',
    'user.email=' + identityEmail,
    'commit',
    '--allow-empty',
    '-m',
    commitMsg
  ]);
  if (!commit.ok && !/nothing to commit/i.test(commit.output || '')) {
    return err('E_GIT', 'git commit 失败：' + (commit.output || commit.error));
  }
  const sha = (await runGit(['rev-parse', '--short', 'HEAD'])).stdout.trim();
  const fileList = (await runGit(['ls-files'])).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const fileCount = fileList.length;
  let pushedBytes = 0;
  for (const rel of fileList) {
    try {
      pushedBytes += (await fsp.stat(path.join(dir, rel))).size;
    } catch {
      /* 忽略统计不到的个别文件 */
    }
  }
  onLog('ok', '已提交 ' + fileCount + ' 个文件（' + sha + '，约 ' + humanBytes(pushedBytes) + '）');

  /* ---------- 3. 建库 / 推送 ---------- */
  onProgress(25, exists ? '推送到已有仓库…' : '创建 GitHub 仓库并推送…');
  const remoteUrl = 'https://github.com/' + owner + '/' + repo + '.git';
  const desc = opts.description ? ['--description', opts.description] : [];
  let pushRes;

  if (!exists) {
    // 注意：这里故意不加 --push。gh 内部 push 走的是它自己的 git 环境，
    // 出问题时既看不到细节也没法换用令牌兜底，所以建库和推送分成两步。
    const createRes = await run(gh, ['repo', 'create', owner + '/' + repo, '--' + visibility, '--source', dir, '--remote', 'origin', ...desc], {
      cwd: dir,
      timeoutMs: 120000,
      onLine: (l) => l.trim() && onLog('info', l.trim().slice(0, 300))
    });
    if (!createRes.ok) {
      // 仓库刚好被别人建了 / 已经有了远端，都退回手动配远端
      onLog('warn', 'gh repo create 未成功，尝试直接配置远端：' + (createRes.output || createRes.error || '').split('\n')[0].slice(0, 160));
      await runGit(['remote', 'remove', 'origin']);
      const add = await runGit(['remote', 'add', 'origin', remoteUrl]);
      if (!add.ok) await runGit(['remote', 'set-url', 'origin', remoteUrl]);
    } else {
      onLog('ok', '仓库已创建：https://github.com/' + owner + '/' + repo);
    }
    pushRes = await runGitAuthed(['push', '-u', 'origin', 'HEAD:main'], { onLine: (l) => l.trim() && onLog('info', l.trim()) });
    if (!pushRes.ok) {
      return err(
        'E_GIT',
        '推送失败：' + (pushRes.output || pushRes.error || '').slice(0, 500),
        '常见原因：网络/代理不通、账号没有该仓库写权限、系统凭据助手被策略禁用（可先执行 gh auth setup-git 再重试）'
      );
    }
    onLog('ok', '推送完成');
  } else {
    onLog('warn', '仓库已存在，执行覆盖推送（reuse=true）');
    await runGit(['remote', 'remove', 'origin']);
    const add = await runGit(['remote', 'add', 'origin', remoteUrl]);
    if (!add.ok) await runGit(['remote', 'set-url', 'origin', remoteUrl]);
    pushRes = await runGitAuthed(['push', '-u', 'origin', 'HEAD:main', '--force'], { onLine: (l) => l.trim() && onLog('info', l.trim()) });
    if (!pushRes.ok) {
      return err('E_GIT', '推送失败：' + (pushRes.output || pushRes.error || '').slice(0, 500), '确认你对该仓库有写权限');
    }
    onLog('ok', '覆盖推送完成');
  }

  /* ---------- 4. 开启 Pages ---------- */
  onProgress(55, '开启 GitHub Pages…');
  const sourceArgs = ['-f', 'source[branch]=main', '-f', 'source[path]=/'];
  let pages = await ghApi(gh, ['--method', 'POST', 'repos/' + owner + '/' + repo + '/pages', ...sourceArgs]);
  if (!pages.ok) {
    onLog('info', 'Pages 可能已经开启，改为更新配置…');
    pages = await ghApi(gh, ['--method', 'PUT', 'repos/' + owner + '/' + repo + '/pages', ...sourceArgs]);
  }
  if (!pages.ok) {
    const detail = (pages.output || '').slice(0, 400);
    if (/private/i.test(detail) || /upgrade/i.test(detail)) {
      return err('E_PAGES', '无法为私有仓库开启 Pages', '把仓库可见性改成「公开」后重试（免费账号不支持私有仓库的 Pages）', detail);
    }
    onLog('warn', 'Pages 接口返回异常，仍继续等待构建：' + detail);
    warnings.push('Pages 开启接口返回异常，已继续等待构建结果。');
  } else {
    onLog('ok', 'GitHub Pages 已开启（分支 main · 根目录 /）');
  }

  /* ---------- 5. 轮询构建 ---------- */
  onProgress(65, '等待 Pages 构建…');
  const htmlUrl = siteType === 'user' ? 'https://' + owner + '.github.io/' : 'https://' + owner + '.github.io/' + repo + '/';
  let lastStatus = null;
  let built = false;
  const pollStart = Date.now();
  while (Date.now() - pollStart < PAGES_TIMEOUT_MS) {
    const info = await ghApi(gh, ['repos/' + owner + '/' + repo + '/pages']);
    if (info.ok && info.json) {
      lastStatus = info.json.status || null;
      const elapsed = Math.round((Date.now() - pollStart) / 1000);
      onProgress(65 + Math.min(28, Math.round((elapsed / (PAGES_TIMEOUT_MS / 1000)) * 28)), 'Pages 状态：' + (lastStatus || '排队中') + '（' + elapsed + 's）');
      if (lastStatus === 'built') {
        built = true;
        break;
      }
      if (lastStatus === 'errored') {
        const builds = await ghApi(gh, ['repos/' + owner + '/' + repo + '/pages/builds/latest']);
        return err('E_PAGES', 'Pages 构建失败（errored）', '打开仓库的 Actions 页面查看构建日志', builds.output ? builds.output.slice(0, 400) : null);
      }
    } else if (info.notFound) {
      onLog('info', 'Pages 还没就绪（404），继续等待…');
    }
    await sleep(PAGES_POLL_MS);
  }
  if (!built) {
    warnings.push('等待 Pages 构建超时（7 分钟），链接可能稍后才可用，可以稍后打开验证。');
    onLog('warn', '等待构建超时，仍返回链接供你稍后查看');
  } else {
    onLog('ok', 'Pages 构建完成');
  }

  /* ---------- 6. 强制 HTTPS ---------- */
  onProgress(94, '开启 HTTPS（强制跳转）…');
  let httpsEnforced = false;
  for (let i = 0; i < 6; i++) {
    const cur = await ghApi(gh, ['repos/' + owner + '/' + repo + '/pages']);
    if (cur.ok && cur.json) {
      httpsEnforced = !!cur.json.https_enforced;
      if (httpsEnforced) break;
    }
    const put = await ghApi(gh, ['--method', 'PUT', 'repos/' + owner + '/' + repo + '/pages', '-F', 'https_enforced=true']);
    if (put.ok) {
      httpsEnforced = true;
      onLog('ok', '已开启 HTTPS 强制跳转');
      break;
    }
    const why = (put.output || '').slice(0, 200);
    if (/certificate/i.test(why)) {
      onLog('info', '证书还在签发中，' + 10 + ' 秒后重试…');
    } else if (why) {
      onLog('info', 'HTTPS 设置暂未成功：' + why.replace(/\s+/g, ' ').slice(0, 160));
    }
    await sleep(10000);
  }
  if (!httpsEnforced) {
    warnings.push('HTTPS 强制跳转还没开启成功，GitHub 通常会在证书签发后自动开启；也可以到仓库 Settings → Pages 勾选 Enforce HTTPS。');
  }

  /* ---------- 7. 复核线上页面 ---------- */
  onProgress(97, '复核线上页面…');
  const verify = await verifyOnline(htmlUrl, forbidden, { onLog });
  if (verify.checkedValues === 0) {
    onLog('warn', '没有可复核的敏感原值，本次只验证了链接能不能访问');
  }
  if (verify.ok) onLog('ok', '线上复核通过：HTTP ' + verify.httpStatus + '，核对了 ' + verify.checkedValues + ' 个原值，未发现残留');
  else if (verify.httpStatus === 0) onLog('warn', '线上页面还没能访问（可能仍在部署），稍后请自行打开链接确认');
  else onLog('error', '线上复核发现问题：' + (verify.leftover.length ? '仍有 ' + verify.leftover.length + ' 项敏感信息' : 'HTTP ' + verify.httpStatus));

  /* ---------- 8. 报告留档 ---------- */
  if (opts.reportPath) {
    try {
      await fsp.appendFile(
        opts.reportPath,
        '\n\n---\n\n## 上线信息\n\n' +
          '- 线上地址：' + htmlUrl + '\n' +
          '- 仓库地址：https://github.com/' + owner + '/' + repo + '\n' +
          '- 可见性：' + visibility + '（' + (siteType === 'user' ? '用户站点' : '项目站点') + '）\n' +
          '- Pages 状态：' + (lastStatus || '未知') + ' · HTTPS 强制：' + (httpsEnforced ? '已开启' : '未确认') + '\n' +
          '- 线上复核：' + (verify.ok ? '通过（HTTP ' + verify.httpStatus + '，无残留）' : verify.httpStatus === 0 ? '暂未访问成功' : '发现残留 ' + verify.leftover.map((l) => softMask(l)).join('、')) + '\n' +
          '- 上线时间：' + nowIso() + '\n',
        'utf8'
      );
    } catch (e) {
      warnings.push('报告追加失败：' + e.message);
    }
  }

  onProgress(100, '上线完成');
  onLog('ok', '🎉 上线完成：' + htmlUrl);
  return {
    ok: true,
    url: htmlUrl,
    repoUrl: 'https://github.com/' + owner + '/' + repo,
    owner,
    repo,
    siteType,
    visibility,
    commitSha: sha,
    fileCount,
    pushedBytes,
    elapsedMs: Date.now() - started,
    pages: { status: lastStatus, htmlUrl, httpsEnforced, buildLogUrl: 'https://github.com/' + owner + '/' + repo + '/actions' },
    verify,
    warnings
  };
}

/** 抓取线上页面，确认可访问且不含应被隐藏的内容 */
async function verifyOnline(url, forbidden, { onLog, attempts = 8, gapMs = 15000 } = {}) {
  const out = { ok: false, httpStatus: 0, checkedAt: nowIso(), leftover: [], attempted: 0, checkedValues: forbidden.filter(Boolean).length };
  const cacheBust = '?_dd=' + Date.now();
  for (let i = 0; i < attempts; i++) {
    out.attempted = i + 1;
    try {
      const res = await fetchWithRetry(url + cacheBust, { retries: 1, timeoutMs: 20000, headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
      out.httpStatus = res.status;
      if (res.status === 200) {
        const html = await res.text();
        out.leftover = forbidden.filter((v) => v && html.includes(v)).map((v) => v);
        out.ok = out.leftover.length === 0;
        out.bytes = html.length;
        return out;
      }
      if (res.status === 404) {
        onLog && onLog('info', '线上页面暂未发布（404），' + Math.round(gapMs / 1000) + ' 秒后重试…（第 ' + (i + 1) + '/' + attempts + ' 次）');
      } else {
        onLog && onLog('warn', '线上返回 HTTP ' + res.status + '，稍后重试…');
      }
    } catch (e) {
      out.httpStatus = 0;
      onLog && onLog('info', '暂时访问不到线上页面（' + e.message + '），稍后重试…');
    }
    if (i < attempts - 1) await sleep(gapMs);
  }
  return out;
}

function repoName(input, siteType, owner) {
  if (siteType === 'user') return owner.toLowerCase() + '.github.io';
  return slugify(input || '', 'my-portfolio');
}

module.exports = { deploy, verifyOnline, repoName };
