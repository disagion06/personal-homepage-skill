#!/usr/bin/env node
'use strict';
/**
 * 静态自检：node scripts/check-page.cjs <站点目录> [--json] [--screenshot]
 *
 * 纯 Node，零依赖，**不需要 Electron**。检查的是「发布后会不会坏」这一类问题：
 * 裂图、外链资源、缺 viewport、标题层级、alt、单文件约束、ASCII 文件名、reduced-motion。
 *
 * 加 --screenshot 时，如果环境里有 Electron，会额外做真实渲染截图与横向溢出检测。
 *
 * 退出码：0 = 无 error；1 = 有 error。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const htmlLib = require('../lib/html');
const util = require('../lib/util');

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/** 带 src/href 且指向外部地址就算违规的元素（<a> 除外，外链是正常的） */
const RESOURCE_ATTRS = { img: 'src', script: 'src', link: 'href', source: 'src', video: 'src', audio: 'src', iframe: 'src', embed: 'src' };

const findings = [];
function add(level, code, title, detail) {
  findings.push({ level, code, title, detail: detail || '' });
}

function getAttr(el, name) {
  const a = (el.attrs || []).find((x) => x.name === name);
  return a ? a.rawValue : null;
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const wantShot = args.includes('--screenshot');
  const dir = path.resolve(args.find((a) => !a.startsWith('--') && a !== argValue(args, '--json')) || '.');

  const entry = path.join(dir, 'index.html');
  if (!fs.existsSync(entry)) {
    console.error('找不到入口文件：' + entry);
    process.exit(1);
  }

  const html = fs.readFileSync(entry, 'utf8');
  const parsed = htmlLib.parse(html);
  const els = parsed.elements;

  /* ---------- 1. 基本结构 ---------- */
  const hasViewport = els.some((el) => {
    if (el.name !== 'meta' || el.closing) return false;
    const n = getAttr(el, 'name');
    return n && /^["']?viewport["']?$/i.test(n);
  });
  if (!hasViewport) {
    add('error', 'META', '缺少 viewport meta', '手机端会按 980px 缩放，响应式完全失效。加 <meta name="viewport" content="width=device-width, initial-scale=1">');
  }

  const titleEl = els.find((el) => el.name === 'title' && !el.closing);
  if (!titleEl) add('warn', 'TITLE', '没有 <title>', '浏览器标签页会是空白或文件路径');

  const h1s = els.filter((el) => el.name === 'h1' && !el.closing);
  if (h1s.length === 0) add('warn', 'H1', '没有 h1', '页面缺少主标题');
  else if (h1s.length > 1) add('warn', 'H1', '有 ' + h1s.length + ' 个 h1', '一个页面建议只有一个主标题');

  /* ---------- 2. 标题层级跳级 ---------- */
  const heads = els
    .filter((el) => /^h[1-6]$/.test(el.name) && !el.closing)
    .map((el) => Number(el.name[1]));
  let skips = 0;
  for (let i = 1; i < heads.length; i++) if (heads[i] - heads[i - 1] > 1) skips++;
  if (skips > 0) add('warn', 'HEADING', '标题层级有跳级 ' + skips + ' 处', '例如 h1 直接跳到 h3，屏幕阅读器会困惑');

  if (!els.some((el) => el.name === 'main' && !el.closing)) {
    add('info', 'MAIN', '没有 <main> 容器', '加语义容器有利于无障碍与 SEO');
  }

  /* ---------- 3. 未闭合标签 ---------- */
  const unclosed = els.filter(
    (el) => !el.closing && !el.selfClosing && !VOID_TAGS.has(el.name) && el.closeStart < 0 && el.innerEnd < 0
  );
  if (unclosed.length) {
    add('error', 'UNCLOSED', '有 ' + unclosed.length + ' 个标签没闭合', unclosed.slice(0, 5).map((e) => '<' + e.name + '>').join(' '));
  }

  /* ---------- 4. 图片：alt 与文件是否存在 ---------- */
  const imgs = els.filter((el) => el.name === 'img' && !el.closing);
  const missingAlt = imgs.filter((el) => getAttr(el, 'alt') === null);
  if (missingAlt.length) {
    add('warn', 'ALT', '有 ' + missingAlt.length + ' 张图片缺 alt', 'alt 用于无障碍与图片加载失败时的替代文字');
  }

  const missingFiles = [];
  for (const el of imgs) {
    const raw = getAttr(el, 'src');
    if (!raw) {
      add('error', 'IMG-SRC', '<img> 没有 src', '空 src 会请求当前页面自身');
      continue;
    }
    const src = raw.replace(/^["']|["']$/g, '').trim();
    if (/^(https?:|data:)/i.test(src)) continue;
    if (src.startsWith('/')) {
      add('warn', 'IMG-ABS', '图片用了根路径 ' + src, 'GitHub Pages 项目站点部署在子路径下，根路径会 404；请用相对路径');
      continue;
    }
    let decoded = src;
    try { decoded = decodeURIComponent(src); } catch { /* 保留原样 */ }
    const abs = path.join(dir, decoded.split('?')[0].split('#')[0]);
    if (!fs.existsSync(abs)) missingFiles.push(src);
  }
  if (missingFiles.length) {
    add('error', 'IMG-404', '有 ' + missingFiles.length + ' 张图片文件不存在', missingFiles.slice(0, 8).join(' , '));
  }

  /* ---------- 5. 外部 CDN 资源 ---------- */
  const externals = [];
  for (const el of els) {
    const attr = RESOURCE_ATTRS[el.name];
    if (!attr || el.closing) continue;
    const v = getAttr(el, attr);
    if (!v) continue;
    const url = v.replace(/^["']|["']$/g, '').trim();
    if (/^https?:\/\//i.test(url)) externals.push('<' + el.name + ' ' + attr + '="' + url + '">');
  }
  if (externals.length) {
    add('error', 'CDN', '引用了 ' + externals.length + ' 个外部资源', externals.slice(0, 5).join(' '));
  }

  /* ---------- 6. 单文件约束 ---------- */
  const externalCss = els.filter((el) => el.name === 'link' && !el.closing && /stylesheet/i.test(getAttr(el, 'rel') || ''));
  const hasStyleTag = els.some((el) => el.name === 'style' && !el.closing);
  const hasScriptTag = els.some((el) => el.name === 'script' && !el.closing && getAttr(el, 'src') === null);
  if (externalCss.length) {
    add('warn', 'SINGLE', '引用了外部 CSS 文件', 'R1 要求单文件内嵌，外部文件转发时容易漏掉');
  }
  if (!hasStyleTag) add('warn', 'SINGLE', '没有内联 <style>', 'R1 要求 CSS 内嵌，否则样式可能丢失');
  if (hasScriptTag) add('info', 'SINGLE', '含内联 <script>', '确认尊重 prefers-reduced-motion');

  /* ---------- 7. reduced-motion ---------- */
  const hasMotion = /@keyframes|animation\s*:|transition\s*:/.test(html);
  const hasReducedMotion = /prefers-reduced-motion/.test(html);
  if (hasMotion && !hasReducedMotion) {
    add('warn', 'A11Y', '有动效但没有 prefers-reduced-motion 兜底', 'R6：加 @media (prefers-reduced-motion: reduce) 把动效关掉');
  }

  /* ---------- 8. JS 注入图片路径（R3） ---------- */
  if (/\.src\s*=|setAttribute\s*\(\s*['"]src['"]/.test(html) && imgs.length === 0) {
    add('warn', 'R3', '页面似乎靠 JS 注入图片路径', 'R3 要求图片写死静态 src；靠 JS 注入会在发布后裂图');
  }

  /* ---------- 9. 占位符残留 ---------- */
  if (/lorem\s+ipsum/i.test(html)) add('warn', 'PLACEHOLDER', '含 Lorem ipsum 占位文字', '换成真实中文文案');
  if (/TODO|待填|占位内容|请在此处填写/.test(html)) add('warn', 'PLACEHOLDER', '含占位标记', '发布前清掉');

  /* ---------- 10. 素材文件名 ASCII（R4） ---------- */
  const assetsDir = path.join(dir, 'assets');
  if (fs.existsSync(assetsDir)) {
    const bad = fs.readdirSync(assetsDir).filter((n) => /[^\x20-\x7e]/.test(n) || /\s/.test(n) || /[^A-Za-z0-9._-]/.test(n));
    if (bad.length) {
      add('error', 'R4', '有 ' + bad.length + ' 个素材文件名不符合 ASCII 规范', bad.slice(0, 8).join(' , '));
    }
  }

  /* ---------- 截图（可选） ---------- */
  let screenshot = null;
  if (wantShot) {
    const shot = runScreenshot(dir);
    screenshot = shot;
    if (shot && shot.ok) {
      for (const f of shot.findings || []) add(f.level, f.code, f.title, f.detail);
    } else if (shot && shot.reason) {
      add('info', 'SHOT', '跳过截图自检', shot.reason);
    }
  }

  /* ---------- 输出 ---------- */
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');
  const infos = findings.filter((f) => f.level === 'info');

  if (jsonOut) {
    console.log(JSON.stringify({ ok: errors.length === 0, dir, findings, counts: { errors: errors.length, warnings: warns.length, infos: infos.length }, screenshot }, null, 2));
  } else {
    console.log('静态自检 · ' + dir);
    console.log('  入口：' + path.relative(process.cwd(), entry));
    console.log('  图片 ' + imgs.length + ' 张，标题 ' + heads.length + ' 个，h1 ' + h1s.length + ' 个');
    console.log('');

    const label = { error: '必须修', warn: '建议修', info: '说明' };
    for (const level of ['error', 'warn', 'info']) {
      const list = findings.filter((f) => f.level === level);
      if (!list.length) continue;
      console.log(label[level] + '（' + list.length + '）');
      for (const f of list) {
        console.log('  [' + f.code + '] ' + f.title);
        if (f.detail) console.log('      ' + f.detail);
      }
      console.log('');
    }

    if (screenshot && screenshot.ok) {
      console.log('截图：');
      for (const v of screenshot.viewports || []) console.log('  ' + v.viewport + '  ' + v.size + '  ' + v.shot);
      console.log('');
    }

    console.log(
      errors.length
        ? '结论：未通过，' + errors.length + ' 项必须修'
        : '结论：通过（无 error）' + (warns.length ? '，另有 ' + warns.length + ' 项建议修' : '')
    );
  }

  process.exit(errors.length ? 1 : 0);
}

/** 有 Electron 就做真实渲染截图；没有就优雅跳过 */
function runScreenshot(dir) {
  let electronPath = '';
  try {
    const e = require('electron');
    electronPath = typeof e === 'string' ? e : '';
  } catch {
    electronPath = '';
  }
  if (!electronPath) {
    return { ok: false, reason: '未检测到 Electron（可选依赖）。静态检查已完成；如需真实渲染截图，npm i -D electron 后重试' };
  }
  const script = path.join(__dirname, 'screenshot.cjs');
  const outDir = path.join(dir, '.selfcheck');
  const r = spawnSync(electronPath, [script, dir, '--out', outDir], { encoding: 'utf8' });
  if (r.error) return { ok: false, reason: r.error.message };
  const jsonPath = path.join(outDir, 'report.json');
  if (!fs.existsSync(jsonPath)) return { ok: false, reason: '截图脚本没有产出报告' };
  try {
    const rep = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return { ok: true, viewports: rep.viewports, findings: rep.findings };
  } catch (e) {
    return { ok: false, reason: '报告解析失败：' + e.message };
  }
}

main();
