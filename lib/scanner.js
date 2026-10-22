'use strict';
/**
 * 站点扫描：把「设计稿文件夹」里的个人敏感信息归纳出来。
 *
 * 产出两类结果：
 *   findings —— 文本类（手机号 / 邮箱 / 姓名 / 地址 / 密钥 …），按「值」聚合，
 *               同一个邮箱出现 3 次只算一项，用户做一次决定即可；
 *   images   —— 图片类（人像照片 / EXIF 拍摄信息 / GPS 坐标）。
 */
const fsp = require('fs/promises');
const path = require('path');
const { RULES, makeCustomRule, CATEGORY } = require('./rules');
const htmlLib = require('./html');
const exifLib = require('./exif');
const { relPosix, lineColAt, humanBytes, nowIso } = require('./util');

const TEXT_EXT = new Set([
  '.html', '.htm', '.xhtml', '.css', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.map',
  '.txt', '.md', '.markdown', '.xml', '.svg', '.webmanifest', '.yml', '.yaml', '.ini', '.cfg', '.conf',
  '.env', '.php', '.vue', '.svelte', '.csv', '.srt', '.vtt', '.htaccess', '.gitignore', '.editorconfig'
]);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.svg', '.ico']);
const SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '__pycache__', '.idea', '.vscode', '.npmcache']);
const PORTRAIT_RE = /(证件照|工作照|生活照|头像|照片|自拍|个人照|portrait|avatar|profile|selfie|photo|idcard|id-card)/i;
const SUGGEST_EXCLUDE_RE = [
  { re: /^_/, reason: '以 “_” 开头的目录通常是备份 / 截图 / 草稿，不该随站点公开' },
  { re: /^\./, reason: '隐藏目录' }
];
const SOURCE_FILE_EXT = new Set(['.psd', '.psb', '.ai', '.sketch', '.fig', '.xd', '.docx', '.doc', '.xlsx', '.pptx', '.key', '.zip', '.rar', '.7z', '.aep', '.prproj', '.blend', '.indd']);

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

/* ----------------------------------------------------------- 文件遍历 */

async function walk(root, onLog) {
  const files = [];
  const dirs = [];
  async function visit(dir, depth) {
    if (depth > 12) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      onLog && onLog('warn', '无法读取目录 ' + dir + '：' + e.message);
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        dirs.push(full);
        await visit(full, depth + 1);
      } else if (ent.isFile()) {
        let st;
        try {
          st = await fsp.stat(full);
        } catch {
          continue;
        }
        files.push({ path: full, rel: relPosix(root, full), name: ent.name, ext: path.extname(ent.name).toLowerCase(), bytes: st.size, mtime: st.mtimeMs });
      }
    }
  }
  await visit(root, 0);
  return { files, dirs };
}

/** 判断一个 buffer 是否是文本（无 NUL 字节） */
function looksText(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

/* ----------------------------------------------------------- 站点根定位 */

async function resolveSiteRoot(input) {
  let p = path.resolve(input);
  const st = await fsp.stat(p).catch(() => null);
  if (!st) throw Object.assign(new Error('路径不存在：' + input), { code: 'E_NOT_FOUND' });
  if (st.isFile()) p = path.dirname(p);

  const hasIndex = async (d) => {
    try {
      const s = await fsp.stat(path.join(d, 'index.html'));
      return s.isFile();
    } catch {
      return false;
    }
  };
  if (await hasIndex(p)) return { siteRoot: p, indexHtml: 'index.html', note: null };

  // 向下找一层：用户可能拖进来的是「作品展示网站」的父目录
  let entries = [];
  try {
    entries = await fsp.readdir(p, { withFileTypes: true });
  } catch {
    /* ignore */
  }
  const candidates = [];
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    if (await hasIndex(path.join(p, e.name))) candidates.push(path.join(p, e.name));
  }
  if (candidates.length === 1) {
    return { siteRoot: candidates[0], indexHtml: 'index.html', note: '已自动定位到子目录 ' + path.basename(candidates[0]) };
  }
  if (candidates.length > 1) {
    throw Object.assign(new Error('该目录下有多个含 index.html 的子目录，请直接选中其中一个：' + candidates.map((c) => path.basename(c)).join('、')), {
      code: 'E_BAD_INPUT'
    });
  }
  // 没有 index.html，但有别的 html
  const htmls = [];
  for (const e of entries) {
    if (e.isFile() && /\.html?$/i.test(e.name)) htmls.push(e.name);
  }
  if (htmls.length) {
    const pick = htmls.includes('index.html') ? 'index.html' : htmls[0];
    return { siteRoot: p, indexHtml: pick, note: '未找到 index.html，将以 ' + pick + ' 作为入口' };
  }
  return { siteRoot: p, indexHtml: null, note: '未找到 HTML 入口文件，仍可继续（生成结果可能不是一个网页）' };
}

/* ----------------------------------------------------------- 文本扫描 */

function makeSnippet(text, start, end, wide = 42) {
  const from = Math.max(0, start - wide);
  const to = Math.min(text.length, end + wide);
  return (from > 0 ? '…' : '') + text.slice(from, start) + '⟪' + text.slice(start, end) + '⟫' + text.slice(end, to) + (to < text.length ? '…' : '');
}

/**
 * 在单个文本文件里找出所有命中。
 * @returns Array<{rule, start, end, value, loc, ctx}>
 */
function scanText(file, text, rules, onLog) {
  const isMarkup = /\.(html?|xhtml|svg|xml|vue|php)$/i.test(file.ext);
  let parsed = null;
  if (isMarkup) {
    try {
      parsed = htmlLib.parse(text);
    } catch (e) {
      onLog && onLog('warn', 'HTML 解析失败，退化为按纯文本扫描：' + file.rel);
    }
  }
  const matches = [];

  for (const rule of rules) {
    let raw = [];
    if (rule.detectMarkup && parsed) {
      try {
        raw = raw.concat(rule.detectMarkup(text, { parsed, elements: parsed.elements, file }) || []);
      } catch (e) {
        onLog && onLog('warn', '规则 ' + rule.id + ' 结构检测出错：' + e.message);
      }
    }
    if (rule.detect) {
      try {
        raw = raw.concat(rule.detect(text, { file, parsed }) || []);
      } catch (e) {
        onLog && onLog('warn', '规则 ' + rule.id + ' 检测出错：' + e.message);
        continue;
      }
    }
    if (rule.pattern) {
      rule.pattern.lastIndex = 0;
      let m;
      let guard = 0;
      while ((m = rule.pattern.exec(text))) {
        if (guard++ > 20000) break;
        if (m[0] === '') {
          rule.pattern.lastIndex++;
          continue;
        }
        const groupIdx = rule.capture || 0;
        const value = m[groupIdx];
        if (value === undefined || value === null) continue;
        const offset = m[0].indexOf(value);
        const start = m.index + (offset < 0 ? 0 : offset);
        raw.push({ start, end: start + value.length, value, m });
      }
    }
    for (const item of raw) {
      if (!item || item.value == null) continue;
      const value = String(item.value);
      if (!value.trim()) continue;

      const loc = parsed ? htmlLib.locate(parsed, item.start) : { kind: 'text', token: null, element: null, attr: null };
      if (loc.kind === 'doctype' || loc.kind === 'tag') continue; // 落在标签名/尖括号里，不动它

      const ctx = {
        html: text,
        index: item.start,
        file: file.rel,
        parsed,
        loc,
        item,
        before: text.slice(Math.max(0, item.start - 160), item.start),
        after: text.slice(item.end, item.end + 160),
        ownerClassText: () => {
          if (!parsed || !loc.element) return '';
          const parts = [];
          let cur = loc.element;
          for (let up = 0; up < 4 && cur; up++) {
            for (const a of cur.attrs || []) {
              if (a.name === 'class' || a.name === 'id') parts.push(a.rawValue || '');
            }
            cur = cur.parent >= 0 ? parsed.elements[cur.parent] : null;
          }
          return parts.join(' ');
        },
        parentText: () => {
          if (!parsed || !loc.element) return '';
          const el = loc.element;
          const p = el.parent >= 0 ? parsed.elements[el.parent] : null;
          if (!p) return '';
          const end = p.closeStart >= 0 ? p.closeStart : p.end;
          return htmlLib.stripTags(text.slice(p.innerStart, end)).replace(/\s+/g, ' ');
        },
        elementText: () => {
          if (!parsed || !loc.element) return '';
          const el = loc.element;
          const end = el.closeStart >= 0 ? el.closeStart : el.end;
          return htmlLib.stripTags(text.slice(el.innerStart, end)).replace(/\s+/g, ' ');
        }
      };

      if (rule.gate) {
        let pass = false;
        try {
          pass = !!rule.gate(item.m || [value], ctx);
        } catch {
          pass = false;
        }
        if (!pass) continue;
      }
      matches.push({ rule, start: item.start, end: item.end, value, loc, ctx, ranges: item.ranges || [{ start: item.start, end: item.end }] });
    }
  }

  // 区间去重：起点早的优先，同起点时长的优先（例如「详细住址」赢过其中的「城市」）
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start < lastEnd) continue;
    kept.push(m);
    lastEnd = m.end;
  }
  return kept;
}

/** 收集所有 HTML 里 <img> 的 alt 文案，用来识别人像照片（文件名常是拼音） */
function collectImgAlt(filesText, siteRoot, onLog) {
  const map = new Map();
  const tagRe = /<img\b[^>]*>/gi;
  for (const { file, text } of filesText) {
    if (!/\.(html?|xhtml)$/i.test(file.ext)) continue;
    const dir = path.posix.dirname(file.rel) === '.' ? '' : path.posix.dirname(file.rel);
    let m;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(text))) {
      const tag = m[0];
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);
      const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag);
      if (!src || !alt || !alt[1]) continue;
      let s = src[1].split('?')[0].split('#')[0].trim();
      if (/^(https?:|data:|\/\/)/i.test(s)) continue;
      s = s.replace(/^\.\//, '');
      const rel = s.startsWith('/') ? s.slice(1) : dir ? dir + '/' + s : s;
      const arr = map.get(rel) || [];
      arr.push(alt[1]);
      map.set(rel, arr);
    }
  }
  return map;
}

/* ----------------------------------------------------------- 图片扫描 */

async function scanImages(files, siteRoot, onLog, altMap) {
  const out = [];
  const imageFiles = files.filter((f) => IMAGE_EXT.has(f.ext));
  for (const f of imageFiles) {
    if (f.ext === '.svg') continue; // svg 当文本处理
    let item = null;
    const tags = [];
    const alts = (altMap && altMap.get(f.rel)) || [];
    const altHit = alts.find((a) => PORTRAIT_RE.test(a));
    if (PORTRAIT_RE.test(f.name) || PORTRAIT_RE.test(f.rel) || altHit) tags.push('人像照片');
    try {
      if (f.bytes <= 24 * 1024 * 1024) {
        const buf = await fsp.readFile(f.path);
        const info = exifLib.inspectImage(buf, f.ext);
        item = { w: info.size ? info.size.w : null, h: info.size ? info.size.h : null, gps: info.gps, exif: info.exif || {}, hasExif: !!info.hasExif };
        if (info.gps) tags.push('含拍摄地点(GPS)');
        if (info.hasExif) tags.push('含 EXIF 元数据');
        const ex = info.exif || {};
        if (ex.artist) tags.push('EXIF 含作者名');
        if (ex.description && /[\u4e00-\u9fa5]/.test(ex.description)) tags.push('EXIF 含中文描述');
        if (ex.software) tags.push('EXIF 含软件信息');
      } else {
        item = { w: null, h: null, gps: null, exif: {}, hasExif: false, skipped: '文件较大，未读取元数据' };
      }
    } catch (e) {
      onLog && onLog('warn', '读取图片失败 ' + f.rel + '：' + e.message);
      item = { w: null, h: null, gps: null, exif: {}, hasExif: false };
    }
    const isPortrait = tags.includes('人像照片');
    const sensitiveMeta = !!(item.gps || (item.exif && (item.exif.artist || item.exif.description || item.exif.model || item.exif.software || item.exif.datetime)));
    out.push({
      id: 'img:' + f.rel,
      rel: f.rel,
      path: f.path,
      bytes: f.bytes,
      w: item.w,
      h: item.h,
      ext: f.ext,
      tags,
      isPortrait,
      gps: item.gps,
      exif: item.exif || {},
      defaultAction: isPortrait ? 'mask' : sensitiveMeta ? 'mask' : 'keep',
      note: item.skipped || null
    });
  }
  // 人像优先、含 GPS 次之
  out.sort((a, b) => Number(b.isPortrait) - Number(a.isPortrait) || Number(!!b.gps) - Number(!!a.gps) || b.bytes - a.bytes);
  return out;
}

/* ----------------------------------------------------------- 主入口 */

/**
 * @param {object} opts
 * @param {string} opts.root 用户拖入的文件夹或文件
 * @param {string[]} [opts.customKeywords]
 * @param {number} [opts.largeFileThresholdMB]
 * @param {(level:string,msg:string)=>void} [opts.onLog]
 */
async function scan(opts = {}) {
  const onLog = opts.onLog || (() => {});
  const threshold = (opts.largeFileThresholdMB || 50) * 1024 * 1024;
  const { siteRoot, indexHtml, note } = await resolveSiteRoot(opts.root);
  onLog('info', '站点根目录：' + siteRoot);

  const warnings = [];
  if (note) warnings.push(note);

  const { files } = await walk(siteRoot, onLog);
  const totalBytes = files.reduce((s, f) => s + f.bytes, 0);
  onLog('info', '共 ' + files.length + ' 个文件，合计 ' + humanBytes(totalBytes));

  const rules = RULES.slice();
  const custom = makeCustomRule(opts.customKeywords);
  if (custom) rules.push(custom);

  /* ---- 文本扫描 ---- */
  const textFiles = files.filter((f) => TEXT_EXT.has(f.ext) || (f.bytes <= 2 * 1024 * 1024 && !IMAGE_EXT.has(f.ext) && !f.ext.match(/\.(mp4|mov|avi|mkv|webm|mp3|wav|zip|rar|7z|pdf|psd|ai|docx?|xlsx?|pptx?|ttf|otf|woff2?|eot)$/i)));
  const allMatches = [];
  const filesText = [];
  let scannedText = 0;
  for (const f of textFiles) {
    if (f.bytes > 8 * 1024 * 1024) continue;
    let buf;
    try {
      buf = await fsp.readFile(f.path);
    } catch (e) {
      onLog('warn', '读取失败 ' + f.rel + '：' + e.message);
      continue;
    }
    if (!looksText(buf) && !TEXT_EXT.has(f.ext)) continue;
    scannedText++;
    const text = buf.toString('utf8');
    filesText.push({ file: f, text });
    const hits = scanText(f, text, rules, onLog);
    for (const h of hits) allMatches.push({ file: f, ...h, text });
  }
  onLog('info', '已检查 ' + scannedText + ' 个文本文件，命中 ' + allMatches.length + ' 处');

  /* ---- 按值聚合 ---- */
  const groups = new Map();
  for (const m of allMatches) {
    const key = m.rule.id + '\u0000' + m.value;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        ruleId: m.rule.id,
        ruleLabel: m.rule.label,
        category: m.rule.category,
        severity: m.rule.severity,
        reason: m.rule.reason,
        defaultAction: m.rule.defaultAction || 'mask',
        value: m.value,
        occurrences: [],
        files: new Set()
      };
      groups.set(key, g);
    }
    const { line, col } = lineColAt(m.text, m.start);
    g.files.add(m.file.rel);
    if (g.occurrences.length < 60) {
      g.occurrences.push({
        file: m.file.rel,
        line,
        col,
        kind: m.loc.kind,
        tag: m.loc.element ? m.loc.element.name : m.loc.token && m.loc.token.type === 'tag' ? m.loc.token.name : null,
        attr: m.loc.attr ? m.loc.attr.name : null,
        snippet: makeSnippet(m.text, m.start, m.end),
        ranges: m.ranges,
        span: { start: m.start, end: m.end },
        classHint: (() => {
          try {
            const t = m.ctx.ownerClassText();
            return t ? t.slice(0, 80) : null;
          } catch {
            return null;
          }
        })()
      });
    }
    g.count = (g.count || 0) + 1;
  }

  const findings = [...groups.values()]
    .map((g) => {
      let maskPreview = '';
      try {
        const rule = rules.find((r) => r.id === g.ruleId);
        maskPreview = rule && rule.mask ? String(rule.mask(g.value, {})) : '';
      } catch {
        maskPreview = '';
      }
      return {
        id: '',
        value: g.value,
        preview: g.value.length > 80 ? g.value.slice(0, 79) + '…' : g.value,
        ruleId: g.ruleId,
        ruleLabel: g.ruleLabel,
        category: g.category,
        severity: g.severity,
        reason: g.reason,
        maskPreview,
        defaultAction: g.defaultAction,
        count: g.count,
        files: [...g.files],
        occurrences: g.occurrences
      };
    })
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) ||
        (b.count - a.count) ||
        a.ruleLabel.localeCompare(b.ruleLabel, 'zh')
    );
  findings.forEach((f, i) => {
    f.id = 'v:' + i;
  });

  /* ---- 图片 ---- */
  const altMap = collectImgAlt(filesText, siteRoot, onLog);
  const images = await scanImages(files, siteRoot, onLog, altMap);

  /* ---- 大文件 & 建议排除 ---- */
  const largeFiles = files
    .filter((f) => f.bytes >= threshold)
    .sort((a, b) => b.bytes - a.bytes)
    .map((f) => ({ rel: f.rel, path: f.path, bytes: f.bytes }));
  if (largeFiles.length) {
    warnings.push('有 ' + largeFiles.length + ' 个文件超过 ' + Math.round(threshold / 1024 / 1024) + 'MB，GitHub 单文件上限 100MB，超过 50MB 会拖慢上传。');
  }

  const suggestedExcludes = [];
  const dirSet = new Map();
  for (const f of files) {
    const segs = f.rel.split('/');
    if (segs.length > 1) {
      const top = segs[0];
      const hit = SUGGEST_EXCLUDE_RE.find((r) => r.re.test(top));
      if (hit && !SKIP_DIRS.has(top)) {
        const cur = dirSet.get(top) || { rel: top + '/', reason: hit.reason, files: 0, bytes: 0 };
        cur.files++;
        cur.bytes += f.bytes;
        dirSet.set(top, cur);
      }
    }
    if (SOURCE_FILE_EXT.has(f.ext)) {
      suggestedExcludes.push({ rel: f.rel, reason: '设计源文件（' + f.ext + '），上线时无需公开', files: 1, bytes: f.bytes });
    }
  }
  suggestedExcludes.unshift(...[...dirSet.values()].sort((a, b) => b.bytes - a.bytes));
  const htmlOthers = files.filter((f) => /\.html?$/i.test(f.ext) && f.rel !== indexHtml);
  if (htmlOthers.length) {
    warnings.push(
      '除入口外还有 ' + htmlOthers.length + ' 个 HTML 文件（' + htmlOthers.slice(0, 3).map((f) => f.rel).join('、') +
        (htmlOthers.length > 3 ? ' 等' : '') + '）。它们同样会被公开访问，如果只是旧版备份建议排除。'
    );
  }

  const stats = {
    files: files.length,
    bytes: totalBytes,
    textFiles: scannedText,
    images: images.length,
    htmlFiles: files.filter((f) => /\.html?$/i.test(f.ext)).length,
    biggest: files
      .slice()
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 5)
      .map((f) => ({ rel: f.rel, bytes: f.bytes }))
  };

  return {
    ok: true,
    root: siteRoot,
    inputRoot: path.resolve(opts.root),
    siteRoot,
    name: path.basename(siteRoot),
    indexHtml,
    scannedAt: nowIso(),
    stats,
    largeFiles,
    largeFileThresholdMB: Math.round(threshold / 1024 / 1024),
    suggestedExcludes,
    findings,
    images,
    warnings,
    fileList: files.map((f) => ({ rel: f.rel, bytes: f.bytes, ext: f.ext }))
  };
}

module.exports = { scan, scanText, walk, resolveSiteRoot, TEXT_EXT, IMAGE_EXT, SKIP_DIRS, PORTRAIT_RE };
