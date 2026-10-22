'use strict';
/**
 * 进程执行层。
 *
 * 设计要点（很重要，别改成 child_process.exec）：
 *  1. 标准输出/错误 **不走管道**，而是重定向到临时文件后轮询增量读取。
 *     - 管道在受限环境（容器 / 沙箱 / 某些杀软策略）下会因命名管道不可用而 EPERM；
 *     - 文件重定向也避免了长输出把管道缓冲区写满导致子进程卡死。
 *  2. 所有命令用参数数组调用，不经过 shell，杜绝路径里空格 / 特殊字符引发的转义问题。
 *  3. 支持 onLine 回调实现实时日志（轮询间隔 120ms）。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ensureDir, rmrf, toPosix } = require('./util');

const IS_WIN = process.platform === 'win32';

/** 在 PATH（含 PATHEXT 扩展名）中查找可执行文件 */
function which(cmd, extraDirs = []) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;

  const dirs = [
    ...extraDirs,
    ...String(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
  ];
  const exts = IS_WIN
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
        .split(';')
        .filter(Boolean)
    : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch {
        /* ignore */
      }
    }
    // 某些环境 PATH 里带引号
    const alt = dir.replace(/^"|"$/g, '');
    if (alt !== dir) {
      for (const ext of exts) {
        const full = path.join(alt, cmd + ext);
        try {
          if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return null;
}

let seq = 0;

/** Windows 命令行参数加引号（配合 windowsVerbatimArguments 使用） */
function quoteWin(s) {
  s = String(s);
  if (s === '') return '""';
  if (!/[\s"&|<>^()]/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}

/**
 * 执行命令并实时收集输出。
 * @param {string} cmd 可执行文件名或绝对路径
 * @param {string[]} args
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {object} [opts.env] 追加的环境变量
 * @param {(line:string, stream:'out'|'err')=>void} [opts.onLine]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.stdinFile] 用文件作为标准输入（例如 gh auth login --with-token）
 * @param {boolean} [opts.shell] 通过 cmd.exe /c 执行（.cmd/.bat 必须走这条路）
 * @param {boolean} [opts.inherit] 直接把输出接到父进程（调试用）
 * @returns {Promise<{code:number|null, ok:boolean, stdout:string, stderr:string, output:string, cmdline:string, timedOut:boolean, error:string|null, ms:number}>}
 */
async function run(cmd, args = [], opts = {}) {
  const started = Date.now();
  const exe = path.isAbsolute(cmd) ? cmd : which(cmd, opts.extraDirs || []);
  let cmdline = [cmd, ...args].join(' ');
  let spawnExe = exe;
  let spawnArgs = args;
  let verbatim = false;

  if (opts.shell) {
    const line = [cmd, ...args].map(quoteWin).join(' ');
    cmdline = line;
    spawnExe = process.env.ComSpec || 'cmd.exe';
    // 整个命令行再包一层引号：cmd /s 的解析规则要求首字符是引号时首尾引号成对，
    // 否则带空格的路径会被截断（"'C:\Program' 不是内部或外部命令"）。
    spawnArgs = ['/d', '/s', '/c', '"' + line + '"'];
    verbatim = true;
  }

  if (!exe) {
    return {
      code: null,
      ok: false,
      stdout: '',
      stderr: '',
      output: '',
      cmdline,
      timedOut: false,
      error: 'ENOENT: 找不到命令 ' + cmd,
      ms: 0
    };
  }

  const tmp = path.join(os.tmpdir(), 'dd-run-' + process.pid + '-' + seq++ + '-' + crypto.randomBytes(3).toString('hex'));
  await ensureDir(tmp);
  const outFile = path.join(tmp, 'out.txt');
  const errFile = path.join(tmp, 'err.txt');

  let fdOut = null;
  let fdErr = null;
  let fdIn = null;
  try {
    fdOut = fs.openSync(outFile, 'a');
    fdErr = fs.openSync(errFile, 'a');
  } catch (e) {
    return { code: null, ok: false, stdout: '', stderr: '', output: '', cmdline, timedOut: false, error: '无法创建输出文件: ' + e.message, ms: 0 };
  }
  if (opts.stdinFile) {
    try {
      fdIn = fs.openSync(opts.stdinFile, 'r');
    } catch (e) {
      try { fs.closeSync(fdOut); fs.closeSync(fdErr); } catch {}
      await rmrf(tmp);
      return { code: null, ok: false, stdout: '', stderr: '', output: '', cmdline, timedOut: false, error: '无法打开输入文件: ' + e.message, ms: 0 };
    }
  }

  const env = {
    ...process.env,
    ...(opts.env || {}),
    GIT_TERMINAL_PROMPT: '0', // 禁止 git 卡在交互式账号密码输入
    NO_COLOR: '1',
    CLICOLOR: '0',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_PROMPT_DISABLED: opts.env && opts.env.GH_PROMPT_DISABLED ? opts.env.GH_PROMPT_DISABLED : process.env.GH_PROMPT_DISABLED
  };

  const child = spawn(spawnExe, spawnArgs, {
    cwd: opts.cwd || process.cwd(),
    env,
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
    stdio: opts.inherit ? 'inherit' : [fdIn === null ? 'ignore' : fdIn, fdOut, fdErr]
  });

  let stdout = '';
  let stderr = '';
  let outPos = 0;
  let errPos = 0;
  let closed = false;
  let timedOut = false;

  const readChunk = (file, pos) => {
    try {
      const buf = fs.readFileSync(file);
      if (buf.length <= pos) return { text: '', pos };
      return { text: buf.slice(pos).toString('utf8'), pos: buf.length };
    } catch {
      return { text: '', pos };
    }
  };

  let pendingOut = '';
  let pendingErr = '';
  const emit = (text, stream) => {
    if (!opts.onLine || !text) return;
    const buf = (stream === 'out' ? pendingOut : pendingErr) + text;
    const parts = buf.split(/\r?\n/);
    if (stream === 'out') pendingOut = parts.pop();
    else pendingErr = parts.pop();
    for (const line of parts) {
      if (line.trim() !== '' || opts.keepEmptyLines) opts.onLine(line, stream);
    }
  };

  const timer = setInterval(() => {
    const o = readChunk(outFile, outPos);
    if (o.text) {
      outPos = o.pos;
      stdout += o.text;
      emit(o.text, 'out');
    }
    const e = readChunk(errFile, errPos);
    if (e.text) {
      errPos = e.pos;
      stderr += e.text;
      emit(e.text, 'err');
    }
  }, 120);
  timer.unref && timer.unref();

  let timeoutHandle = null;
  const result = await new Promise((resolve) => {
    const finish = (code, error) => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // 收尾：把剩余内容读干净
      const o = readChunk(outFile, outPos);
      stdout += o.text;
      if (pendingOut) { emit(pendingOut, 'out'); pendingOut = ''; }
      const e = readChunk(errFile, errPos);
      stderr += e.text;
      if (pendingErr) { emit(pendingErr, 'err'); pendingErr = ''; }
      resolve({ code, error: error || null });
    };

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch {}
        setTimeout(() => finish(child.exitCode, 'TIMEOUT'), 400);
      }, opts.timeoutMs);
    }

    child.on('error', (err) => finish(null, err.code || err.message));
    child.on('close', (code) => finish(code, null));
  });

  try { fs.closeSync(fdOut); } catch {}
  try { fs.closeSync(fdErr); } catch {}
  if (fdIn !== null) { try { fs.closeSync(fdIn); } catch {} }
  await rmrf(tmp);

  if (timedOut) {
    stderr += '\n[超时] 命令执行超过 ' + Math.round(opts.timeoutMs / 1000) + ' 秒，已强制结束。';
  }

  const ok = !timedOut && !result.error && result.code === 0;
  return {
    code: result.code,
    ok,
    stdout,
    stderr,
    output: (stdout + (stderr ? '\n' + stderr : '')).trim(),
    cmdline,
    timedOut,
    error: result.error,
    ms: Date.now() - started
  };
}

/** run 的封装：失败抛异常，异常对象带 .result */
async function runOrThrow(cmd, args = [], opts = {}) {
  const r = await run(cmd, args, opts);
  if (!r.ok) {
    const err = new Error(
      '命令失败：' + r.cmdline + '\n' + (r.output || r.error || '退出码 ' + r.code)
    );
    err.result = r;
    err.code = 'E_CMD';
    throw err;
  }
  return r;
}

/**
 * 在独立的控制台窗口里运行交互式命令（例如 gh auth login）。
 * Windows 用 `cmd /c start` 打开新窗口，失败时回退到后台无窗口执行。
 */
function openTerminal(commandLine, opts = {}) {
  const title = opts.title || '设计稿上线助手 · GitHub 登录';
  if (IS_WIN) {
    const inner = 'title ' + title + ' && ' + commandLine + ' && echo. && echo [登录窗口] 完成后可直接关闭本窗口 & pause';
    const child = spawn('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', inner], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    return { ok: true, mode: 'terminal' };
  }
  const child = spawn('x-terminal-emulator', ['-e', 'bash', '-lc', commandLine + '; read -p "按回车关闭"'], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  return { ok: true, mode: 'terminal' };
}

/** 检查网络连通性（不需要第三方依赖，用 Node 内建 fetch） */
async function netCheck(url = 'https://api.github.com/', timeoutMs = 6000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: ac.signal, headers: { 'User-Agent': 'design-deployer' } });
    return { ok: res.status < 500, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? '连接超时' : e.message };
  } finally {
    clearTimeout(t);
  }
}

/** 带重试的 fetch */
async function fetchWithRetry(url, { retries = 3, timeoutMs = 15000, headers = {}, method = 'GET' } = {}) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        signal: ac.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'design-deployer', 'Cache-Control': 'no-cache', ...headers }
      });
      return res;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(t);
    }
    if (i < retries) await sleep(800 * (i + 1));
  }
  throw lastErr || new Error('fetch 失败');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { which, run, runOrThrow, openTerminal, netCheck, fetchWithRetry, sleep, quoteWin, IS_WIN, toPosix };
