'use strict';
/**
 * 截图自检层：把关 C6 / C7，并在真实渲染环境里验证页面能打开。
 *
 * 为什么不用 playwright：
 *   本项目是 Electron 应用，**Electron 本身就是 Chromium**。
 *   用内置 BrowserWindow 就能截图、能监听 console、能跑 JS 探针，
 *   完全符合项目「零运行时依赖」约定，还省掉 playwright 那 300MB 浏览器下载。
 *
 * 能查出什么（对应网页制作流程里的手工自检）：
 *   - 页面能否打开、有没有 404 / 资源加载失败
 *   - JS 运行时异常（走 DevTools 协议 Runtime.exceptionThrown，最准）
 *   - 横向溢出（scrollWidth > clientWidth）
 *   - 图片裂图（naturalWidth === 0）
 *   - 文字重叠（C7：同一行相邻行内元素会误报，因此判 warn 而非 error）
 *   - 动效元素初始 opacity:0 导致量不到（C6：先强制显形再测）
 *   - 桌面 / 移动两套视口截图
 *
 * 只能跑在 Electron 环境里（主进程或 electron 脚本）。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const util = require('./util');

/* ------------------------------------------------------------ 严重度 */

const LEVELS = { error: 'error', warn: 'warn', info: 'info' };

/* ------------------------------------------------------------ 页面探针 */

/**
 * 注入页面执行的探针，返回可 JSON 序列化的测量结果。
 * 注意：字符串会被 executeJavaScript 执行，因此不能引用 Node 侧变量。
 */
const PROBE_SOURCE = `
(() => {
  const out = {};

  // ---- C6：动效元素初始 opacity:0，先强制显形，否则后面全都量不到 ----
  const revealed = [];
  const hidden = [];
  document.querySelectorAll('*').forEach((el) => {
    const cs = getComputedStyle(el);
    const op = parseFloat(cs.opacity);
    if (cs.opacity !== '' && op === 0 && el.getClientRects().length) {
      hidden.push(el);
    }
  });
  hidden.forEach((el) => {
    el.style.setProperty('opacity', '1', 'important');
    el.style.setProperty('transform', 'none', 'important');
    el.style.setProperty('visibility', 'visible', 'important');
    revealed.push(el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''));
  });
  out.forcedVisibleCount = revealed.length;
  out.forcedVisibleSample = revealed.slice(0, 8);

  // ---- 横向溢出 ----
  const doc = document.documentElement;
  out.scrollWidth = doc.scrollWidth;
  out.clientWidth = doc.clientWidth;
  out.overflowX = Math.max(0, doc.scrollWidth - doc.clientWidth);
  out.scrollHeight = doc.scrollHeight;

  // 找出真正把宽度撑开的元素（排除 html/body 自身）
  const culprits = [];
  if (out.overflowX > 0) {
    const limit = doc.clientWidth;
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const right = r.left + window.scrollX + r.width;
      if (right > limit + 2) {
        culprits.push({
          tag: el.tagName.toLowerCase(),
          cls: typeof el.className === 'string' ? el.className.trim().slice(0, 60) : '',
          right: Math.round(right),
          width: Math.round(r.width)
        });
      }
    });
    out.overflowCulprits = culprits.slice(0, 10);
  }

  // ---- 裂图 ----
  const imgs = [...document.images];
  out.imageCount = imgs.length;
  out.brokenImages = imgs
    .filter((img) => !img.complete || img.naturalWidth === 0)
    .map((img) => ({ src: (img.currentSrc || img.src || '').slice(0, 200), alt: img.alt || '' }))
    .slice(0, 20);

  // ---- 结构性检查 ----
  out.title = document.title || '';
  out.hasViewportMeta = !!document.querySelector('meta[name="viewport"]');
  const h1s = [...document.querySelectorAll('h1')];
  out.h1Count = h1s.length;
  out.hasMain = !!document.querySelector('main');
  out.lang = document.documentElement.lang || '';

  // 标题层级是否跳级（h1 -> h3）
  const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1]));
  let skips = 0;
  for (let i = 1; i < heads.length; i++) {
    if (heads[i] - heads[i - 1] > 1) skips++;
  }
  out.headingSkips = skips;

  // ---- C7：文字重叠检测 ----
  // 只比较「直接承载文本的叶子元素」，并且要求重叠面积占比够大，
  // 这样同一行相邻 <b>/<span> 的测量误报会被过滤掉。
  const textEls = [];
  document.querySelectorAll('body *').forEach((el) => {
    const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!hasOwnText) return;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return;
    textEls.push({ el, r });
  });

  const overlaps = [];
  const MAX = 320;
  const list = textEls.slice(0, MAX);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i].r;
      const b = list[j].r;
      const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ix <= 2 || iy <= 2) continue;
      const inter = ix * iy;
      const smaller = Math.min(a.width * a.height, b.width * b.height);
      const ratio = smaller > 0 ? inter / smaller : 0;
      // 只有「几乎完全压住对方」才算真重叠；且两个元素不能是祖孙关系
      if (ratio < 0.35) continue;
      const A = list[i].el;
      const B = list[j].el;
      if (A.contains(B) || B.contains(A)) continue;
      overlaps.push({
        a: A.tagName.toLowerCase() + (typeof A.className === 'string' && A.className.trim() ? '.' + A.className.trim().split(/\\s+/)[0] : ''),
        b: B.tagName.toLowerCase() + (typeof B.className === 'string' && B.className.trim() ? '.' + B.className.trim().split(/\\s+/)[0] : ''),
        aText: (A.textContent || '').trim().slice(0, 30),
        bText: (B.textContent || '').trim().slice(0, 30),
        ratio: Math.round(ratio * 100) / 100
      });
      if (overlaps.length >= 10) break;
    }
    if (overlaps.length >= 10) break;
  }
  out.overlaps = overlaps;
  out.textElCount = textEls.length;

  // ---- 字体 ----
  out.fontsStatus = document.fonts ? document.fonts.status : 'unknown';

  return out;
})()
`;

/* ------------------------------------------------------------ 只读探针（不动 DOM） */

/** 用于拿到 scrollHeight 以决定整页截图高度，不修改任何样式 */
const METRICS_SOURCE = `
(() => ({
  scrollHeight: document.documentElement.scrollHeight,
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
  clientHeight: document.documentElement.clientHeight
}))()
`;

/* ------------------------------------------------------------ Electron 取用 */

function requireElectron() {
  let electron;
  try {
    electron = require('electron');
  } catch (e) {
    throw new Error('lib/selfcheck.js 只能在 Electron 环境里运行（请用 electron 启动，或经主进程调用）');
  }
  if (!electron || typeof electron.BrowserWindow !== 'function') {
    throw new Error('当前不是 Electron 主进程环境：需要 BrowserWindow 才能做截图自检');
  }
  return electron;
}

/* ------------------------------------------------------------ 主流程 */

/**
 * 对某个站点目录做截图自检。
 *
 * @param {object} options
 * @param {string} options.dir 站点目录（含 index.html）
 * @param {string} [options.entry='index.html']
 * @param {string} [options.shotsDir] 截图输出目录（默认 <dir>/.selfcheck）
 * @param {{name:string,width:number,height:number,isMobile?:boolean}[]} [options.viewports]
 * @param {boolean} [options.fullPage=true] 是否整页截图（有高度上限）
 * @param {number} [options.settleMs=600] 加载后等待动效稳定的时间
 * @returns {Promise<object>} 自检报告
 */
async function checkSite(options = {}) {
  const { BrowserWindow } = requireElectron();

  const dir = path.resolve(options.dir || '.');
  const entry = options.entry || 'index.html';
  const entryPath = path.join(dir, entry);
  const shotsDir = path.resolve(options.shotsDir || path.join(dir, '.selfcheck'));
  const settleMs = options.settleMs != null ? options.settleMs : 600;
  const fullPage = options.fullPage !== false;
  const maxShotHeight = options.maxShotHeight || 6000;

  if (!(await util.exists(entryPath))) {
    throw new Error('找不到入口文件：' + entryPath);
  }
  await util.ensureDir(shotsDir);

  const viewports = options.viewports || [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844, isMobile: true }
  ];

  const findings = [];
  const push = (level, code, title, detail, extra) =>
    findings.push({ level, code, title, detail: detail || '', ...(extra || {}) });

  const consoleLogs = [];
  const exceptions = [];
  const netFailures = new Set();

  const win = new BrowserWindow({
    show: false,
    width: viewports[0].width,
    height: viewports[0].height,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      // 独立 session，避免污染主界面，也方便单独监听网络失败
      partition: 'selfcheck-' + Date.now()
    }
  });

  const wc = win.webContents;

  // —— console 消息（兼容新旧两版签名）——
  wc.on('console-message', (...args) => {
    const first = args[0];
    let level;
    let message;
    let line = 0;
    let sourceId = '';
    if (first && typeof first === 'object' && typeof first.message === 'string') {
      level = first.level;
      message = first.message;
      line = first.lineNumber || 0;
      sourceId = first.sourceId || '';
    } else {
      level = args[1];
      message = args[2];
      line = args[3] || 0;
      sourceId = args[4] || '';
    }
    const isError = level === 3 || level === 'error';
    const isWarning = level === 2 || level === 'warning';
    if (isError || isWarning) {
      consoleLogs.push({ level: isError ? 'error' : 'warn', message: String(message).slice(0, 300), line, sourceId });
    }
  });

  // —— 网络失败 ——
  try {
    wc.session.webRequest.onErrorOccurred((details) => {
      // 只看本页发起的资源
      if (details.error && details.error !== 'net::ERR_ABORTED') {
        netFailures.add((details.url || '').slice(0, 200) + ' → ' + details.error);
      }
    });
  } catch {
    /* 某些环境不允许挂 webRequest，忽略 */
  }

  // —— DevTools 协议：最准确的 JS 异常捕获 ——
  let debuggerAttached = false;
  try {
    wc.debugger.attach('1.3');
    debuggerAttached = true;
    await wc.debugger.sendCommand('Runtime.enable');
    await wc.debugger.sendCommand('Log.enable');
    wc.debugger.on('message', (event, method, params) => {
      if (method === 'Runtime.exceptionThrown') {
        const d = params.exceptionDetails || {};
        const desc =
          (d.exception && (d.exception.description || d.exception.value)) || d.text || '未知异常';
        exceptions.push({ text: String(desc).slice(0, 400), line: d.lineNumber || 0, url: d.url || '' });
      }
      if (method === 'Log.entryAdded') {
        const e = params.entry || {};
        if (e.level === 'error' && e.source === 'network') {
          netFailures.add(String(e.text || '').slice(0, 200) + ' ' + String(e.url || '').slice(0, 160));
        }
      }
    });
  } catch {
    /* 调试协议不可用时降级为 console 监听 */
  }

  const results = [];

  try {
    for (const vp of viewports) {
      win.setContentSize(vp.width, vp.height);

      const loaded = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('页面加载超时（' + vp.name + '）')), options.timeoutMs || 30000);
        wc.once('did-finish-load', () => {
          clearTimeout(timer);
          resolve();
        });
        wc.once('did-fail-load', (_e, code, desc, url) => {
          clearTimeout(timer);
          reject(new Error('页面加载失败：' + desc + ' (' + code + ') ' + url));
        });
      });

      // 每次视口都重新加载，确保媒体查询从干净状态生效
      wc.loadFile(entryPath).catch(() => {});
      await loaded;

      // 给动效 / 字体 / 图片一点时间稳定
      await delay(settleMs);

      // 探针：先量尺寸，必要时把窗口拉到整页高度再截图
      const metrics = await wc.executeJavaScript(METRICS_SOURCE, true).catch(() => null);
      let shotTarget = null;
      if (fullPage && metrics && metrics.scrollHeight > vp.height) {
        const h = Math.min(metrics.scrollHeight, maxShotHeight);
        win.setContentSize(vp.width, h);
        await delay(250);
        shotTarget = await wc.executeJavaScript(METRICS_SOURCE, true).catch(() => null);
      }

      const probe = await wc.executeJavaScript(PROBE_SOURCE, true).catch((e) => {
        return { probeError: String(e && e.message ? e.message : e) };
      });

      const img = await wc.capturePage();
      const shotName = 'shot-' + vp.name + '.png';
      const shotPath = path.join(shotsDir, shotName);
      await fsp.writeFile(shotPath, img.toPNG());

      results.push({
        viewport: vp.name,
        width: vp.width,
        height: vp.height,
        shot: shotPath,
        scrollHeight: probe && probe.scrollHeight,
        overflowX: probe && probe.overflowX,
        probe: probe || null
      });
    }
  } finally {
    try {
      if (debuggerAttached) wc.debugger.detach();
    } catch {
      /* ignore */
    }
    win.destroy();
  }

  /* ---------------- 把测量结果翻译成人能读的结论 ---------------- */

  const desktop = results[0] || {};
  const probe = desktop.probe || {};

  if (probe.probeError) {
    push(LEVELS.error, 'PROBE', '页面探针执行失败', probe.probeError);
  }

  // JS 异常
  if (exceptions.length) {
    for (const ex of exceptions.slice(0, 10)) {
      push(LEVELS.error, 'JS', '页面有 JS 运行时异常', ex.text + (ex.line ? '（行 ' + ex.line + '）' : ''));
    }
  }
  // console 报错
  const consoleErrors = consoleLogs.filter((l) => l.level === 'error');
  for (const ce of consoleErrors.slice(0, 10)) {
    push(LEVELS.error, 'CONSOLE', 'console.error', ce.message);
  }
  if (consoleLogs.length > consoleErrors.length) {
    push(
      LEVELS.warn,
      'CONSOLE-WARN',
      'console 有警告',
      consoleLogs.length - consoleErrors.length + ' 条警告，第一条：' + (consoleLogs.find((l) => l.level === 'warn') || {}).message
    );
  }

  // 资源加载失败
  if (netFailures.size) {
    for (const f of [...netFailures].slice(0, 10)) {
      push(LEVELS.error, 'NET', '资源加载失败', f);
    }
  }

  // 裂图（C5 的运行时验证）
  if (probe.brokenImages && probe.brokenImages.length) {
    for (const b of probe.brokenImages.slice(0, 10)) {
      push(LEVELS.error, 'C5', '图片裂了（naturalWidth=0）', b.src);
    }
  }

  // 横向溢出
  if (probe.overflowX > 0) {
    const culprits = (probe.overflowCulprits || [])
      .map((c) => c.tag + (c.cls ? '.' + c.cls.split(/\s+/)[0] : '') + '（右边界 ' + c.right + 'px）')
      .join('，');
    push(
      LEVELS.error,
      'OVERFLOW',
      '页面横向溢出 ' + probe.overflowX + 'px',
      '可能把宽度撑开的元素：' + (culprits || '未能定位')
    );
  }

  // 文字重叠（C7：判 warn，必须看截图人工确认）
  if (probe.overlaps && probe.overlaps.length) {
    for (const o of probe.overlaps.slice(0, 5)) {
      push(
        LEVELS.warn,
        'C7',
        '疑似文字重叠（需看截图确认）',
        o.a + '「' + o.aText + '」 × ' + o.b + '「' + o.bText + '」 重叠 ' + Math.round(o.ratio * 100) + '%',
        { needsScreenshot: true }
      );
    }
  }

  // C6：动效元素被强制显形这件事必须写进报告，否则截图与真实首屏不一致
  if (probe.forcedVisibleCount > 0) {
    push(
      LEVELS.info,
      'C6',
      '有 ' + probe.forcedVisibleCount + ' 个动效元素初始不可见，测量前已强制显形',
      '截图代表「动效播完后」的样子，不代表首屏瞬间。样例：' + (probe.forcedVisibleSample || []).join('、')
    );
  }

  // 结构检查
  if (!probe.hasViewportMeta) {
    push(LEVELS.warn, 'META', '缺少 viewport meta', '移动端会按 980px 缩放，响应式失效');
  }
  if (probe.h1Count === 0) {
    push(LEVELS.warn, 'SEO', '没有 h1', '页面缺少主标题');
  } else if (probe.h1Count > 1) {
    push(LEVELS.warn, 'SEO', '有 ' + probe.h1Count + ' 个 h1', '一个页面建议只有一个主标题');
  }
  if (probe.headingSkips > 0) {
    push(LEVELS.warn, 'SEO', '标题层级有跳级', '共 ' + probe.headingSkips + ' 处（例如 h1 直接跳到 h3）');
  }
  if (!probe.title) {
    push(LEVELS.warn, 'SEO', '页面没有 title', '浏览器标签页会和标题栏空白');
  }
  if (!probe.hasMain) {
    push(LEVELS.info, 'A11Y', '没有 <main> 容器', '加语义容器有利于无障碍与 SEO');
  }

  const errors = findings.filter((f) => f.level === LEVELS.error);
  const warns = findings.filter((f) => f.level === LEVELS.warn);

  return {
    ok: errors.length === 0,
    dir,
    entry: entryPath,
    checkedAt: util.nowIso(),
    shotsDir,
    viewports: results.map((r) => ({
      viewport: r.viewport,
      size: r.width + '×' + r.height,
      scrollHeight: r.scrollHeight,
      overflowX: r.overflowX,
      shot: r.shot
    })),
    findings,
    summary: {
      errors: errors.length,
      warnings: warns.length,
      infos: findings.filter((f) => f.level === LEVELS.info).length,
      images: probe.imageCount || 0,
      brokenImages: (probe.brokenImages || []).length,
      overflowX: probe.overflowX || 0,
      exceptions: exceptions.length,
      netFailures: netFailures.size,
      confirmedAtRuntime: true
    }
  };
}

/* ------------------------------------------------------------ 报告输出 */

function formatReport(report) {
  const L = [];
  L.push('截图自检报告');
  L.push('  站点：' + report.dir);
  L.push('  时间：' + report.checkedAt);
  L.push(
    '  结论：' +
      (report.ok ? '通过（无阻塞问题）' : '未通过，' + report.summary.errors + ' 项必须修') +
      '，另有 ' + report.summary.warnings + ' 项提醒'
  );
  L.push('');

  L.push('视口截图');
  for (const v of report.viewports) {
    L.push('  ' + v.viewport + '  ' + v.size + '  页高 ' + v.scrollHeight + 'px' + (v.overflowX ? '  横向溢出 ' + v.overflowX + 'px' : '') );
    L.push('    ' + v.shot);
  }
  L.push('');

  const order = { error: 0, warn: 1, info: 2 };
  const sorted = [...report.findings].sort((a, b) => order[a.level] - order[b.level]);

  const groups = [
    ['error', '必须修'],
    ['warn', '需要确认'],
    ['info', '说明']
  ];
  for (const [level, label] of groups) {
    const items = sorted.filter((f) => f.level === level);
    if (!items.length) continue;
    L.push(label + '（' + items.length + '）');
    for (const f of items) {
      L.push('  [' + f.code + '] ' + f.title);
      if (f.detail) L.push('      ' + f.detail);
    }
    L.push('');
  }

  const needShot = report.findings.filter((f) => f.needsScreenshot);
  if (needShot.length) {
    L.push('注意：标记为 C7 的重叠告警历史上经常是检测误报（同一行相邻加粗/数字片段），');
    L.push('      请打开上面的截图逐条确认，确认无误即可忽略。');
  }

  return L.join('\n');
}

/* ------------------------------------------------------------ 小工具 */

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  LEVELS,
  PROBE_SOURCE,
  checkSite,
  formatReport
};
