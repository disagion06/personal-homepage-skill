'use strict';
/**
 * 通用工具函数集合。无第三方依赖。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/* ------------------------------------------------------------------ 路径 */

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** 相对路径，统一用 '/'，且不以 './' 开头 */
function relPosix(from, to) {
  let r = path.relative(from, to);
  if (!r) return '';
  return toPosix(r);
}

/** 判断 child 是否在 parent 之内（含相等） */
function isInside(parent, child) {
  const p = path.resolve(parent).toLowerCase();
  const c = path.resolve(child).toLowerCase();
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** 文件名安全化：用于仓库名 / 目录名 */
function slugify(input, fallback = 'my-portfolio') {
  let s = String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (!s || !/[a-z0-9]/.test(s)) s = fallback;
  if (s.length > 90) s = s.slice(0, 90).replace(/-+$/g, '');
  return s;
}

function timestampTag(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  );
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** 生成一个临时目录 */
async function makeTempDir(prefix = 'dd-') {
  const base = path.join(os.tmpdir(), prefix + crypto.randomBytes(6).toString('hex'));
  await ensureDir(base);
  return base;
}

async function rmrf(target) {
  await fsp.rm(target, { recursive: true, force: true, maxRetries: 3 });
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function statSafe(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ 展示 */

function humanBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return (n >= 100 ? n.toFixed(0) : n.toFixed(n >= 10 ? 1 : 2)) + ' ' + units[i];
}

function truncate(s, n = 60) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* ------------------------------------------------------------------ 其它 */

function uid(prefix = 'id') {
  return prefix + ':' + crypto.randomBytes(4).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** 去重但保持顺序 */
function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** HTML 转义（用于写报告 / 生成占位图里的文字） */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 把字符串做 base64（非敏感场景，例如报告里放缩略信息） */
function b64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

/** 读取 JSON 文件，失败返回 fallback */
function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 简易并发池 */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 计算字符串的行号（1 基）与列号（1 基） */
function lineColAt(text, index) {
  let line = 1;
  let last = -1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, col: index - last };
}

/** 脱敏展示：用于日志里打印用户邮箱/手机号 */
function softMask(s) {
  s = String(s || '');
  if (s.length <= 3) return s[0] + '*'.repeat(Math.max(0, s.length - 1));
  const head = s.slice(0, Math.max(1, Math.ceil(s.length / 4)));
  return head + '*'.repeat(Math.max(3, s.length - head.length));
}

module.exports = {
  toPosix,
  relPosix,
  isInside,
  slugify,
  timestampTag,
  ensureDir,
  makeTempDir,
  rmrf,
  exists,
  statSafe,
  humanBytes,
  truncate,
  uid,
  nowIso,
  clamp,
  uniq,
  escapeHtml,
  b64,
  readJsonSafe,
  pool,
  lineColAt,
  softMask
};
