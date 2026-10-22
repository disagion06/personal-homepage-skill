'use strict';
/**
 * 图片脱敏：人像打码 / 元数据剥离。
 *
 * 打码有两个档位：
 *   1. sharp（推荐）—— 真正的高斯模糊 + 重新编码，顺带把 EXIF 一起去掉，画质可调；
 *   2. 占位图（兜底）—— 当 sharp 装不上（离线、平台不支持）时，用同尺寸的 SVG 占位块
 *      替换原图，并改写页面里对它的引用，保证版式不塌、隐私不泄露。
 */
const fsp = require('fs/promises');
const path = require('path');
const exifLib = require('./exif');
const { escapeHtml } = require('./util');

const sharpCache = new Map(); // key = toolsDir（'' 表示按模块名解析）, value = 模块或 null

/**
 * 尝试加载 sharp。查找顺序：
 *   1) 调用方指定的 toolsDir（程序自动安装插件的目录）
 *   2) 程序自身目录（打包后 resources/app）
 * 缓存按目录区分：在 A 目录没装 sharp 不应该影响后来在 B 目录装好的结果。
 */
function loadSharp(toolsDir) {
  const key = toolsDir || '';
  if (sharpCache.has(key)) return sharpCache.get(key);
  const candidates = [];
  if (toolsDir) candidates.push(path.join(toolsDir, 'node_modules', 'sharp'));
  candidates.push('sharp');
  let found = null;
  for (const c of candidates) {
    try {
      // eslint-disable-next-line global-require
      found = require(c);
      break;
    } catch {
      /* 继续尝试下一个 */
    }
  }
  sharpCache.set(key, found);
  return found;
}

function resetSharpCache() {
  sharpCache.clear();
}

/** 生成与原文同尺寸的「已隐藏」占位 SVG */
function makePlaceholderSvg(w, h, label = '图片已隐藏') {
  const width = Math.max(1, Math.round(w || 800));
  const height = Math.max(1, Math.round(h || 600));
  const short = Math.min(width, height);
  const fs2 = Math.max(12, Math.min(48, Math.round(short / 12)));
  const fs1 = Math.max(10, Math.round(fs2 * 0.62));
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
    width +
    ' ' +
    height +
    '" width="' +
    width +
    '" height="' +
    height +
    '" role="img" aria-label="' +
    escapeHtml(label) +
    '">' +
    '<defs><pattern id="ddp" width="16" height="16" patternUnits="userSpaceOnUse">' +
    '<rect width="16" height="16" fill="#e9ecef"/><rect width="8" height="8" fill="#dfe3e8"/>' +
    '<rect x="8" y="8" width="8" height="8" fill="#dfe3e8"/></pattern></defs>' +
    '<rect width="100%" height="100%" fill="url(#ddp)"/>' +
    '<g fill="none" stroke="#8b93a9" stroke-width="' +
    Math.max(1, Math.round(short / 200)) +
    '">' +
    '<rect x="6" y="6" width="' +
    (width - 12) +
    '" height="' +
    (height - 12) +
    '" rx="6"/>' +
    '</g>' +
    '<g transform="translate(' +
    width / 2 +
    ',' +
    height / 2 +
    ')" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,Microsoft YaHei,sans-serif">' +
    '<text y="' +
    -fs2 * 0.2 +
    '" font-size="' +
    fs2 +
    '" fill="#5b6478" font-weight="600">' +
    escapeHtml(label) +
    '</text>' +
    '<text y="' +
    fs2 * 0.95 +
    '" font-size="' +
    fs1 +
    '" fill="#8b93a9">Protected by DesignDeployer</text>' +
    '</g></svg>'
  );
}

/**
 * 给图片打码。
 * @returns {Promise<{ok:boolean, mode:'sharp'|'placeholder'|'skipped', newRel:string|null, bytes?:number, error?:string}>}
 */
async function maskImage(file, rel, opts = {}) {
  const toolsDir = opts.toolsDir;
  const blur = opts.blur || 24;
  const sharp = loadSharp(toolsDir);

  if (sharp) {
    try {
      const buf = await fsp.readFile(file);
      const meta = await sharp(buf).metadata();
      const W = meta.width || 640;
      const H = meta.height || 480;
      // 打码策略：先缩到 1/20 大小（不可逆地丢掉细节），再用最近邻放大回去，
      // 形成马赛克块。注意 sharp 同一条流水线里写两次 resize 会被优化成最后一次，
      // 所以必须分两次（先 toBuffer 再处理）。
      const factor = Math.max(8, Math.min(48, opts.pixelSize || 20));
      const smallW = Math.max(8, Math.round(W / factor));
      const smallH = Math.max(8, Math.round(H / factor));
      const tiny = await sharp(buf).resize({ width: smallW, height: smallH, fit: 'fill' }).blur(1).toBuffer();
      const out = await sharp(tiny)
        .resize({ width: W, height: H, fit: 'fill', kernel: 'nearest' })
        .toFormat(meta.format === 'png' ? 'png' : 'jpeg', { quality: 72 })
        .toBuffer();
      await fsp.writeFile(file, out);
      return { ok: true, mode: 'sharp', newRel: rel, bytes: out.length, block: factor };
    } catch (e) {
      // sharp 处理失败（例如 avif/heic 不支持）→ 落到占位图
      opts.onLog && opts.onLog('warn', 'sharp 处理 ' + rel + ' 失败，改用占位图：' + e.message);
    }
  }

  // 占位图
  try {
    const buf = await fsp.readFile(file);
    const size = exifLib.imageSize(buf) || { w: 800, h: 600 };
    const svg = makePlaceholderSvg(size.w, size.h, opts.label || '人物照片已隐藏');
    const dir = path.dirname(file);
    const base = path.basename(file).replace(/\.[^.]+$/, '');
    const svgName = base + '.hidden.svg';
    const svgPath = path.join(dir, svgName);
    await fsp.writeFile(svgPath, svg, 'utf8');
    await fsp.rm(file, { force: true });
    const newRel = rel.replace(/[^/]+$/, svgName);
    return { ok: true, mode: 'placeholder', newRel };
  } catch (e) {
    return { ok: false, mode: 'skipped', newRel: null, error: e.message };
  }
}

/**
 * 无损剥离图片元数据（JPEG 的 APPn/COM 段、PNG 的文本块）。
 * @returns {Promise<{ok:boolean, removed:number, mode:string}>}
 */
async function stripMetadata(file, ext) {
  try {
    const buf = await fsp.readFile(file);
    const e = String(ext || path.extname(file)).toLowerCase();
    if (e === '.jpg' || e === '.jpeg') {
      const info = exifLib.parseJpegExif(buf);
      const out = exifLib.stripJpegMetadata(buf);
      if (out.length === buf.length) return { ok: true, removed: 0, mode: 'jpeg' };
      await fsp.writeFile(file, out);
      return { ok: true, removed: out.__removedSegments || 1, mode: 'jpeg', gps: info.gps };
    }
    if (e === '.png') {
      const out = exifLib.stripPngMetadata(buf);
      if (out.length === buf.length) return { ok: true, removed: 0, mode: 'png' };
      await fsp.writeFile(file, out);
      return { ok: true, removed: out.__removedChunks || 1, mode: 'png' };
    }
    return { ok: true, removed: 0, mode: 'unsupported' };
  } catch (e) {
    return { ok: false, removed: 0, mode: 'error', error: e.message };
  }
}

module.exports = { loadSharp, resetSharpCache, maskImage, stripMetadata, makePlaceholderSvg };
