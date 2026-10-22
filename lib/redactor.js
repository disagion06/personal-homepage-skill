'use strict';
/**
 * 生成上线目录：把用户的逐项决定真正落到文件上。
 *
 * 流程：
 *   1. 复制站点到工作区（排除 .git / node_modules / 用户勾掉的文件）
 *   2. 图片先处理（打码会改文件名，文本改写要跟着换引用）
 *   3. 文本文件按「规则重新命中 → 查决定 → 生成编辑」统一改写，
 *      编辑一次性倒序应用，保证偏移量不会错乱
 *   4. 写 .nojekyll / 脱敏说明 / 报告
 *   5. 对生成的目录再扫一遍做自检：选了隐藏却还在 = 失败，必须报出来
 */
const fsp = require('fs/promises');
const path = require('path');
const htmlLib = require('./html');
const images = require('./images');
const exifLib = require('./exif');
const { RULES, makeCustomRule } = require('./rules');
const { scanText, scan, TEXT_EXT } = require('./scanner');
const { ensureDir, rmrf, relPosix, humanBytes, timestampTag, nowIso, softMask } = require('./util');

const HIDE_STYLE = '<style data-design-deployer="hide">[data-dd-hidden]{display:none!important}</style>';
const MILESTONES = { copy: 10, images: 40, text: 80, finish: 100 };

function normRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function isExcluded(rel, excludes) {
  const r = normRel(rel);
  for (const e of excludes || []) {
    const x = normRel(e).replace(/\/+$/, '');
    if (!x) continue;
    if (r === x || r.startsWith(x + '/')) return true;
  }
  return false;
}

/** 打码字符串按区间长度比例分摊到被标签拆开的多个区间上 */
function distributeMask(ranges, masked) {
  const list = ranges && ranges.length ? ranges : null;
  if (!list) return [];
  const total = list.reduce((s, r) => s + (r.end - r.start), 0) || 1;
  const out = [];
  let pos = 0;
  for (let i = 0; i < list.length; i++) {
    const len = list[i].end - list[i].start;
    const take = i === list.length - 1 ? masked.length - pos : Math.round((masked.length * len) / total);
    out.push({ start: list[i].start, end: list[i].end, text: masked.slice(pos, pos + Math.max(0, take)) });
    pos += Math.max(0, take);
  }
  return out;
}

/** 元素去掉标签后是否已经没有可见内容（且不含图片/视频等媒体） */
function isEmptyAfter(html, el, edits) {
  if (!el) return false;
  const text = htmlLib.innerTextAfter(html, el, edits);
  if (text !== '') return false;
  const end = el.closeStart >= 0 ? el.closeStart : el.innerEnd >= 0 ? el.innerEnd : el.end;
  const inner = html.slice(el.innerStart, end);
  if (/<(?:img|video|audio|iframe|canvas|picture|svg)\b/i.test(inner)) return false;
  return true;
}

/** 该元素内部是否存在「标签名」性质的子元素（例如 .info-label） */
function hasLabelishChild(parsed, parent) {
  const LIMIT = /(?:^|[\s_-])(?:label|key|title|caption|head|field-name|item-name|dt)(?:$|[\s_-])/i;
  for (let i = parent.index + 1; i < parsed.elements.length; i++) {
    const e = parsed.elements[i];
    if (e.depth <= parent.depth) break;
    if (LIMIT.test(classOf(e))) return true;
  }
  return false;
}

/** 如果父级正好是「字段名 + 字段值」这种一行式结构，就把隐藏目标升级到父级 */
function upgradeToFieldRow(html, parsed, el, edits) {
  if (!el) return el;
  const parent = el.parent >= 0 ? parsed.elements[el.parent] : null;
  if (!parent) return el;
  if (['body', 'main', 'html', 'head'].includes(parent.name)) return el;
  // 只有父级「去掉本字段后只剩一个短标签」时才升级，避免把整个区块吞掉
  const parentText = htmlLib.innerTextAfter(html, parent, edits);
  if (parentText && parentText.length <= 12 && hasLabelishChild(parsed, parent)) return parent;
  return el;
}

/** 从被删空的元素往上找最外层「还是空的」祖先，作为隐藏目标 */
function findHideTarget(html, parsed, el, edits) {
  if (!el) return null;
  let cur = el;
  let target = null;
  for (let up = 0; up < 5; up++) {
    if (!cur) break;
    if (!isEmptyAfter(html, cur, edits)) break;
    target = cur;
    const parent = cur.parent >= 0 ? parsed.elements[cur.parent] : null;
    if (!parent || ['body', 'main', 'html', 'head'].includes(parent.name)) break;
    if (htmlLib.CARD_CLASS_RE.test(classOf(parent))) break;
    const up2 = upgradeToFieldRow(html, parsed, cur, edits);
    if (up2 !== cur) return up2;
    cur = parent;
  }
  return target ? upgradeToFieldRow(html, parsed, target, edits) : null;
}

function classOf(el) {
  if (!el) return '';
  const c = (el.attrs || []).find((a) => a.name === 'class');
  return c && c.rawValue ? c.rawValue.replace(/^["']|["']$/g, '') : '';
}

/** 把引用了被排除文件的元素摘掉 / 隐藏 */
function neutralizeRefs(html, parsed, rel, edits, onLog, hideEl) {
  const hits = htmlLib.findRefElements(parsed, rel);
  let n = 0;
  const MEDIA_TAGS = new Set(['img', 'video', 'source', 'audio', 'iframe', 'track', 'embed', 'object']);
  for (const hit of hits) {
    const el = hit.element;
    const a = hit.attrObj || {};
    if (/^data-/i.test(hit.attr)) {
      // data-video / data-src 这类：连属性一起摘掉，标记不再指向不存在的文件
      const end = a.valueStart >= 0 ? a.valueEnd + (a.quote ? 1 : 0) : a.nameEnd;
      edits.push({ start: a.nameStart, end, text: '' });
      onLog && onLog('info', '已移除指向「' + rel + '」的属性 ' + hit.attr);
    } else if (MEDIA_TAGS.has(el.name)) {
      edits.push({ start: el.start, end: el.end, text: '' });
      onLog && onLog('info', '已移除引用了「' + rel + '」的 <' + el.name + '> 标签');
    } else if (a.valueStart >= 0) {
      edits.push({ start: a.valueStart, end: a.valueEnd, text: '' });
      onLog && onLog('info', '已清空引用了「' + rel + '」的 ' + hit.attr + ' 属性');
    } else {
      edits.push({ start: el.start, end: el.end, text: '' });
    }

    const card = htmlLib.cardAncestor(parsed, el);
    if (card && hideEl(card)) {
      onLog && onLog('info', '已隐藏引用了「' + rel + '」的整块内容（.' + classOf(card).split(/\s+/)[0] + '）');
    }
    n++;
  }
  return n;
}

/**
 * 主入口。
 * @param {object} opts
 * @param {string} opts.root 源站点目录
 * @param {object} opts.decisions { findingId: 'mask'|'delete'|'hideblock'|'keep' }
 * @param {object} opts.imageDecisions { imageId: 'mask'|'delete'|'keep' }
 * @param {string[]} opts.exclude 要排除的相对路径（文件或目录）
 * @param {object} opts.options { stripExif, siteTitle, addNotice, outParent, customKeywords, workDir, toolsDir }
 * @param {object} opts.scanResult scan() 的结果（缺省时内部重扫）
 */
async function build(opts = {}) {
  const onLog = opts.onLog || (() => {});
  const onProgress = opts.onProgress || (() => {});
  const options = opts.options || {};
  const root = path.resolve(opts.root);
  const excludes = (opts.exclude || []).map(normRel);
  const warnings = [];

  const scanResult = opts.scanResult || (await scan({ root, customKeywords: options.customKeywords, onLog }));
  if (!scanResult || scanResult.ok === false) {
    return { ok: false, error: { code: 'E_BAD_INPUT', message: '扫描失败，无法生成', detail: scanResult && scanResult.error } };
  }
  for (const w of scanResult.warnings || []) warnings.push(w);

  /* ---------------- 1. 准备输出目录 ---------------- */
  const workDir = options.workDir || path.join(require('os').tmpdir(), 'dd-workspaces');
  const name = (scanResult.name || 'site').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40);
  const outDir = options.outDir || path.join(workDir, name + '-' + timestampTag());
  await ensureDir(path.dirname(outDir));
  if (opts.overwrite !== false) await rmrf(outDir);
  await ensureDir(outDir);
  onLog('info', '上线目录：' + outDir);

  onProgress(MILESTONES.copy, '复制站点文件…');
  let copied = 0;
  let copiedBytes = 0;
  let skipped = 0;
  await fsp.cp(root, outDir, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    filter: (src) => {
      const rel = relPosix(root, src);
      if (!rel) return true;
      // 防止把输出目录自己复制进自己
      if (path.resolve(src).toLowerCase().startsWith(path.resolve(outDir).toLowerCase())) return false;
      const base = path.basename(src);
      if (base === '.git' || base === 'node_modules' || base === '.DS_Store' || base === 'Thumbs.db') return false;
      if (isExcluded(rel, excludes)) {
        skipped++;
        return false;
      }
      return true;
    }
  });
  // 统计
  async function walkDir(dir) {
    const out = [];
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries = [];
      try {
        entries = await fsp.readdir(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) {
          const st = await fsp.stat(full).catch(() => null);
          out.push({ path: full, rel: relPosix(outDir, full), bytes: st ? st.size : 0, ext: path.extname(e.name).toLowerCase() });
        }
      }
    }
    return out;
  }
  let outFiles = await walkDir(outDir);
  copied = outFiles.length;
  copiedBytes = outFiles.reduce((s, f) => s + f.bytes, 0);
  onLog('ok', '已复制 ' + copied + ' 个文件（' + humanBytes(copiedBytes) + '）' + (skipped ? '，排除 ' + skipped + ' 项' : ''));

  /* ---------------- 2. 决定映射 ---------------- */
  const decisionMap = new Map(); // ruleId \0 value -> action
  const findingMeta = new Map();
  for (const f of scanResult.findings || []) {
    const action = (opts.decisions && opts.decisions[f.id]) || f.defaultAction || 'mask';
    decisionMap.set(f.ruleId + '\u0000' + f.value, action);
    findingMeta.set(f.ruleId + '\u0000' + f.value, f);
  }
  for (const [k, v] of Object.entries(opts.extraDecisions || {})) decisionMap.set(k, v);

  const applied = new Map(); // key -> {value, ruleId, action, count}
  const imagesReport = [];

  /* ---------------- 3. 图片处理 ---------------- */
  onProgress(MILESTONES.images, '处理图片与元数据…');
  const renames = []; // {from, to}
  const imgDecisions = opts.imageDecisions || {};
  const imageList = (scanResult.images || []).filter((im) => outFiles.some((f) => f.rel === im.rel));
  for (const im of imageList) {
    const action = imgDecisions[im.id] || im.defaultAction || 'keep';
    const target = path.join(outDir, im.rel);
    if (action === 'mask') {
      const res = await images.maskImage(target, im.rel, { toolsDir: options.toolsDir, onLog, label: im.isPortrait ? '人物照片已隐藏' : '图片已隐藏' });
      if (res.ok) {
        if (res.mode === 'placeholder' && res.newRel && res.newRel !== im.rel) renames.push({ from: im.rel, to: res.newRel });
        imagesReport.push({ rel: im.rel, action: 'mask', mode: res.mode, ok: true });
        onLog('ok', '已打码：' + im.rel + (res.mode === 'sharp' ? '（高斯模糊 + 清除元数据）' : '（替换为占位图，sharp 不可用）'));
      } else {
        imagesReport.push({ rel: im.rel, action: 'mask', ok: false, error: res.error });
        warnings.push('图片打码失败：' + im.rel + ' — ' + res.error);
        onLog('error', '图片打码失败：' + im.rel + ' — ' + res.error);
      }
    } else if (action === 'delete') {
      await fsp.rm(target, { force: true });
      renames.push({ from: im.rel, to: null, deleted: true });
      imagesReport.push({ rel: im.rel, action: 'delete', ok: true });
      onLog('ok', '已删除图片：' + im.rel);
    } else {
      // 保留：仍然按选项清理元数据
      if (options.stripExif !== false) {
        const r = await images.stripMetadata(target, im.ext);
        if (r.ok && r.removed > 0) {
          imagesReport.push({ rel: im.rel, action: 'keep', stripped: r.removed });
          onLog('info', '已清除 ' + im.rel + ' 的 ' + r.removed + ' 段元数据（EXIF/GPS）');
        } else {
          imagesReport.push({ rel: im.rel, action: 'keep', stripped: 0 });
        }
      } else {
        imagesReport.push({ rel: im.rel, action: 'keep', skippedStrip: true });
      }
    }
  }
  // 打码/删除后重新统计
  outFiles = await walkDir(outDir);

  /* ---------------- 4. 文本改写 ---------------- */
  onProgress(MILESTONES.text, '改写页面文本…');
  const rules = RULES.slice();
  const custom = makeCustomRule(options.customKeywords);
  if (custom) rules.push(custom);

  const deletedRefs = excludes.filter((e) => {
    const rel = normRel(e);
    return !outFiles.some((f) => f.rel === rel || f.rel.startsWith(rel + '/'));
  });

  let hiddenBlocks = 0;
  let editCount = 0;
  const remaining = new Map();
  const textFiles = outFiles.filter((f) => TEXT_EXT.has(f.ext) || /\.(html?|css|js|json|md|txt|svg|webmanifest)$/i.test(f.rel));

  for (const f of textFiles) {
    let html;
    try {
      html = await fsp.readFile(f.path, 'utf8');
    } catch {
      continue;
    }
    const isMarkup = /\.(html?|xhtml|svg|xml|vue|php)$/i.test(f.ext);
    const parsed = isMarkup ? htmlLib.parse(html) : null;
    const fileObj = { rel: f.rel, ext: f.ext, path: f.path, bytes: f.bytes, name: path.basename(f.path) };
    const edits = [];
    const deleteEdits = [];
    const hiddenIdx = new Set();
    /** 给元素打上「整块隐藏」标记，同一个元素只加一次属性 */
    const hideEl = (el) => {
      if (!el || el.index == null || hiddenIdx.has(el.index)) return false;
      hiddenIdx.add(el.index);
      edits.push(htmlLib.editSetAttr(html, el, 'data-dd-hidden', '1'));
      hiddenBlocks++;
      return true;
    };

    // 4.1 被排除文件的引用
    for (const rel of deletedRefs) {
      if (!parsed) {
        // 非 HTML：直接把路径字符串替换成空
        const idx = html.indexOf(rel);
        if (idx >= 0) {
          edits.push({ start: idx, end: idx + rel.length, text: '' });
          onLog('info', f.rel + '：清除了对已排除文件的引用 ' + rel);
        }
        continue;
      }
      neutralizeRefs(html, parsed, rel, edits, onLog, hideEl);
    }
    // 4.2 被删除的图片：把引用摘掉（占位图改名走 4.3）
    for (const r of renames) {
      if (!r.deleted || !parsed) continue;
      neutralizeRefs(html, parsed, r.from, edits, onLog, hideEl);
    }
    // 4.3 占位图改名：替换路径字符串
    for (const r of renames) {
      if (r.deleted || !r.to || r.from === r.to) continue;
      const variants = new Set([r.from, path.posix.basename(r.from)]);
      for (const v of variants) {
        let idx = html.indexOf(v);
        while (idx >= 0) {
          edits.push({ start: idx, end: idx + v.length, text: v === r.from ? r.to : path.posix.basename(r.to) });
          idx = html.indexOf(v, idx + v.length);
        }
      }
    }

    // 4.4 敏感信息
    const hits = scanText(fileObj, html, rules, onLog);
    for (const hit of hits) {
      const key = hit.rule.id + '\u0000' + hit.value;
      let action = decisionMap.get(key);
      if (action === undefined) action = hit.rule.defaultAction || 'mask';
      const ranges = hit.ranges && hit.ranges.length ? hit.ranges : [{ start: hit.start, end: hit.end }];

      const rec = applied.get(key) || { id: (findingMeta.get(key) || {}).id || null, ruleId: hit.rule.id, ruleLabel: hit.rule.label, category: hit.rule.category, value: hit.value, action, count: 0, files: new Set() };
      rec.action = action;
      rec.files.add(f.rel);

      if (action === 'keep') {
        rec.count++;
        applied.set(key, rec);
        const rem = remaining.get(key) || { value: hit.value, ruleId: hit.rule.id, ruleLabel: hit.rule.label, count: 0, files: new Set() };
        rem.count++;
        rem.files.add(f.rel);
        remaining.set(key, rem);
        continue;
      }

      let maskedText = '';
      if (action === 'mask') {
        try {
          maskedText = String(hit.rule.mask ? hit.rule.mask(hit.value, { file: f.rel }) : '***');
        } catch {
          maskedText = '***';
        }
      }
      if (ranges.length === 1) {
        edits.push({ start: ranges[0].start, end: ranges[0].end, text: maskedText });
      } else {
        for (const e of distributeMask(ranges, maskedText)) edits.push(e);
      }
      if (action === 'delete' || action === 'hideblock') {
        deleteEdits.push({ element: hit.loc.element, loc: hit.loc });
      }
      if (action === 'hideblock' && parsed && hit.loc.element) {
        // 事件处理属性（onclick 等）与脚本体里的内容不该连累整块 UI，只做删除
        const attrName = hit.loc.attr ? hit.loc.attr.name : null;
        const rendersInPage = !attrName || !/^on/i.test(attrName);
        if (rendersInPage && hit.loc.kind !== 'rawtext') {
          let card = htmlLib.cardAncestor(parsed, hit.loc.element) || hit.loc.element;
          card = upgradeToFieldRow(html, parsed, card, edits);
          if (hideEl(card)) {
            const cls = classOf(card);
            onLog('info', f.rel + '：整块隐藏 <' + card.name + (cls ? ' class="' + cls.slice(0, 40) + '"' : '') + '>');
          }
        }
      }
      rec.count++;
      editCount++;
      applied.set(key, rec);
    }

    // 4.5 删除后变空的条目 → 整块隐藏
    if (parsed && deleteEdits.length) {
      for (const d of deleteEdits) {
        const target = findHideTarget(html, parsed, d.element, edits);
        if (target && hideEl(target)) {
          onLog('info', f.rel + '：删除后条目已空，整块隐藏 <' + target.name + ' class="' + classOf(target).slice(0, 40) + '">');
        }
      }
    }

    // 4.6 隐藏样式 & 站点标题 & 脱敏说明
    const needStyle = edits.some((e) => e.__kind === 'attr-add' || e.__kind === 'attr-add-value');
    if (needStyle) {
      const headEnd = /<\/head\s*>/i.exec(html);
      if (headEnd) edits.push({ start: headEnd.index, end: headEnd.index, text: HIDE_STYLE });
      else edits.push({ start: 0, end: 0, text: HIDE_STYLE });
    }
    if (options.siteTitle && f.rel === (scanResult.indexHtml || 'index.html')) {
      const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      if (tm) {
        const s = tm.index + tm[0].indexOf(tm[1]);
        edits.push({ start: s, end: s + tm[1].length, text: String(options.siteTitle) });
      }
    }
    if (options.addNotice && f.rel === (scanResult.indexHtml || 'index.html')) {
      const bodyEnd = /<\/body\s*>/i.exec(html);
      const notice =
        '<div style="padding:10px 14px;font:12px/1.6 system-ui,Microsoft YaHei;color:#6b7280;background:#f8f9fa;border-top:1px solid #e5e7eb;text-align:center">' +
        '本页面已做个人信息脱敏处理 · 由「设计稿上线助手」生成</div>';
      if (bodyEnd) edits.push({ start: bodyEnd.index, end: bodyEnd.index, text: notice });
      else edits.push({ start: html.length, end: html.length, text: notice });
    }

    if (!edits.length) continue;
    const out = htmlLib.applyEdits(html, edits);
    if (out === html) continue;
    try {
      await fsp.writeFile(f.path, out, 'utf8');
      onLog('info', f.rel + '：应用 ' + edits.length + ' 处改动');
    } catch (e) {
      warnings.push('写入失败：' + f.rel + ' — ' + e.message);
      onLog('error', '写入失败：' + f.rel + ' — ' + e.message);
    }
  }

  /* ---------------- 5. .nojekyll ---------------- */
  const hasUnderscore = outFiles.some((f) => f.rel.split('/').some((s) => s.startsWith('_')));
  try {
    await fsp.writeFile(path.join(outDir, '.nojekyll'), '', 'utf8');
    onLog('info', '已写入 .nojekyll（确保 _ 开头的文件也能被 GitHub Pages 正常访问）');
  } catch (e) {
    warnings.push('.nojekyll 写入失败：' + e.message);
  }

  /* ---------------- 6. 自检：对生成结果重新扫描 ---------------- */
  onProgress(95, '自检生成的目录…');
  const leftover = [];
  try {
    const re = await scan({ root: outDir, customKeywords: options.customKeywords });
    for (const f of re.findings || []) {
      const key = f.ruleId + '\u0000' + f.value;
      const action = decisionMap.get(key);
      const isMaskArtifact = /\*|已隐藏|已移除|REDACTED|某学校|某公司/.test(f.value);
      if (isMaskArtifact) continue;
      if (action && action !== 'keep') {
        leftover.push({ value: f.value, ruleId: f.ruleId, ruleLabel: f.ruleLabel, action, count: f.count, files: f.files });
      }
    }
    if (leftover.length) {
      warnings.push('自检发现 ' + leftover.length + ' 项本应隐藏却仍存在的内容，请检查生成结果。');
      onLog('error', '自检未通过：' + leftover.map((l) => l.value).join('、'));
    } else {
      onLog('ok', '自检通过：生成目录里没有发现漏网的敏感信息');
    }
  } catch (e) {
    warnings.push('自检执行失败：' + e.message);
  }

  /* ---------------- 7. 统计与报告 ---------------- */  outFiles = await walkDir(outDir);
  const totalBytes = outFiles.reduce((s, f) => s + f.bytes, 0);

  const appliedList = [...applied.values()].map((r) => ({
    id: r.id,
    ruleId: r.ruleId,
    ruleLabel: r.ruleLabel,
    category: r.category,
    value: r.value,
    action: r.action,
    count: r.count,
    files: [...r.files]
  }));
  const remainingList = [...remaining.values()].map((r) => ({
    value: r.value,
    ruleId: r.ruleId,
    ruleLabel: r.ruleLabel,
    count: r.count,
    files: [...r.files]
  }));

  const reportPath = path.join(path.dirname(outDir), path.basename(outDir) + '-脱敏报告.md');
  const report = renderReport({
    name,
    root,
    outDir,
    indexHtml: scanResult.indexHtml,
    applied: appliedList,
    remaining: remainingList,
    images: imagesReport,
    excluded: excludes,
    leftover,
    hiddenBlocks,
    editCount,
    warnings,
    files: outFiles.length,
    bytes: totalBytes
  });
  try {
    await fsp.writeFile(reportPath, report, 'utf8');
    onLog('info', '脱敏报告：' + reportPath);
  } catch (e) {
    warnings.push('报告写入失败：' + e.message);
  }

  /**
   * 脱敏清单（机器可读）：放在输出目录**外面**，绝不可能被推到 GitHub。
   * 用途：单独执行 deploy 时，主进程可以从这里取回「本应隐藏的原值」，
   * 上线后逐条核对线上页面里是否真的没有它们。没有这份清单，复核就只是「能打开」。
   */
  let manifestPath = null;
  try {
    manifestPath = path.join(path.dirname(outDir), path.basename(outDir) + '-脱敏清单.json');
    await fsp.writeFile(
      manifestPath,
      JSON.stringify(
        {
          outDir,
          reportPath,
          indexHtml: scanResult.indexHtml || 'index.html',
          generatedAt: nowIso(),
          forbiddenValues: appliedList.filter((a) => a.action !== 'keep' && a.value).map((a) => a.value),
          applied: appliedList,
          remaining: remainingList,
          leftover,
          excluded: excludes,
          stats: { files: outFiles.length, bytes: totalBytes }
        },
        null,
        2
      ),
      'utf8'
    );
  } catch (e) {
    manifestPath = null;
    warnings.push('脱敏清单写入失败：' + e.message);
  }

  onProgress(MILESTONES.finish, '生成完成');
  onLog('ok', '生成完成：' + outFiles.length + ' 个文件，' + humanBytes(totalBytes));

  return {
    ok: true,
    outDir,
    name,
    workDir,
    indexHtml: scanResult.indexHtml || 'index.html',
    reportPath,
    manifestPath,
    applied: appliedList,
    remaining: remainingList,
    images: imagesReport,
    excluded: excludes,
    hiddenBlocks,
    editCount,
    leftover,
    hasUnderscoreDir: hasUnderscore,
    stats: { files: outFiles.length, bytes: totalBytes },
    warnings,
    generatedAt: nowIso()
  };
}

function renderReport(d) {
  const L = [];
  L.push('# 上线脱敏报告 · ' + d.name);
  L.push('');
  L.push('> 由「设计稿上线助手」自动生成。报告只记录到程序本地工作区，**不会**被上传到 GitHub。');
  L.push('');
  L.push('| 项目 | 内容 |');
  L.push('| --- | --- |');
  L.push('| 源站点 | `' + d.root + '` |');
  L.push('| 上线目录 | `' + d.outDir + '` |');
  L.push('| 入口文件 | `' + (d.indexHtml || 'index.html') + '` |');
  L.push('| 生成时间 | ' + nowIso() + ' |');
  L.push('| 文件数 / 体积 | ' + d.files + ' 个 / ' + humanBytes(d.bytes) + ' |');
  L.push('| 文本改写处数 | ' + d.editCount + ' |');
  L.push('| 整块隐藏 | ' + d.hiddenBlocks + ' |');
  L.push('');
  L.push('## 一、已处理的敏感信息');
  L.push('');
  if (!d.applied.length) {
    L.push('_无_');
  } else {
    L.push('| 类别 | 类型 | 内容（本地留档，已软打码） | 处理方式 | 次数 | 涉及文件 |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    const zh = { mask: '打码', delete: '删除', hideblock: '隐藏整块', keep: '保留（未处理）' };
    for (const a of d.applied) {
      L.push(
        '| ' +
          a.category +
          ' | ' +
          a.ruleLabel +
          ' | `' +
          softMask(a.value) +
          '` | ' +
          (zh[a.action] || a.action) +
          ' | ' +
          a.count +
          ' | ' +
          a.files.slice(0, 3).join('、') +
          (a.files.length > 3 ? ' 等' + a.files.length + ' 个文件' : '') +
          ' |'
      );
    }
  }
  L.push('');
  L.push('## 二、保留未处理（将随站点公开）');
  L.push('');
  if (!d.remaining.length) {
    L.push('_无，所有敏感项都已处理_');
  } else {
    L.push('| 类型 | 内容 | 次数 | 文件 |');
    L.push('| --- | --- | --- | --- |');
    for (const r of d.remaining) {
      L.push('| ' + r.ruleLabel + ' | `' + softMask(r.value) + '` | ' + r.count + ' | ' + [...r.files].slice(0, 3).join('、') + ' |');
    }
  }
  L.push('');
  if (d.leftover.length) {
    L.push('## 三、⚠ 自检未通过');
    L.push('');
    L.push('以下内容选择了隐藏，但在生成结果里仍能被扫描到：');
    L.push('');
    for (const l of d.leftover) L.push('- `' + softMask(l.value) + '`（' + l.ruleLabel + ' × ' + l.count + '，' + l.files.slice(0, 3).join('、') + '）');
    L.push('');
  }
  L.push('## ' + (d.leftover.length ? '四' : '三') + '、图片处理');
  L.push('');
  if (!d.images.length) {
    L.push('_无_');
  } else {
    L.push('| 图片 | 处理 | 说明 |');
    L.push('| --- | --- | --- |');
    for (const im of d.images) {
      const zh = { mask: '打码', delete: '删除', keep: '保留' };
      let note = '';
      if (im.mode === 'sharp') note = '高斯模糊 + 清除元数据';
      else if (im.mode === 'placeholder') note = '替换为同尺寸占位图';
      else if (im.stripped) note = '清除 ' + im.stripped + ' 段 EXIF 元数据';
      else if (im.ok === false) note = '失败：' + im.error;
      else if (im.action === 'keep') note = im.skippedStrip ? '保留（未清理元数据）' : '保留（无元数据可清）';
      L.push('| `' + im.rel + '` | ' + (zh[im.action] || im.action) + ' | ' + note + ' |');
    }
  }
  L.push('');
  L.push('## ' + (d.leftover.length ? '五' : '四') + '、排除未上传的文件');
  L.push('');
  if (!d.excluded.length) L.push('_无_');
  else for (const e of d.excluded) L.push('- `' + e + '`');
  L.push('');
  if (d.warnings.length) {
    L.push('## ' + (d.leftover.length ? '六' : '五') + '、提示');
    L.push('');
    for (const w of d.warnings) L.push('- ' + w);
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push('_报告结束_');
  return L.join('\n');
}

module.exports = { build, isExcluded, normRel, distributeMask, renderReport };
