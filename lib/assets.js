'use strict';
/**
 * 素材规整层：把关网页制作流程里的 C1–C5 五条硬约束。
 *
 *  C1 素材文件名必须 ASCII / 拼音 —— 中文名、空格、特殊字符会导致发布后裂图
 *  C2 视频必须是 H.264 —— HEVC 编码浏览器播不了，需要转码
 *  C3 PSD / AEP 等源工程不能直接展示 —— 只能导出预览图或标注
 *  C4 视频需要首帧封面 —— 否则黑屏或裂图
 *  C5 图片路径必须能静态引用 —— 这里产出确定性的 ASCII 路径
 *
 * 零第三方依赖：MP4 编码和图片尺寸都是手写解析（与 lib/exif.js 同风格）。
 * 外部工具（ffmpeg / ImageMagick）只在需要时**探测**，缺失则降级并告警，不强求。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const util = require('./util');

/* ------------------------------------------------------------ 常量 */

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.bmp', '.ico']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac']);
const DESIGN_EXT = new Set(['.psd', '.psb', '.aep', '.aepx', '.ai', '.sketch', '.fig', '.xd', '.indd']);
const DOC_EXT = new Set(['.docx', '.doc', '.pdf', '.md', '.txt', '.rtf', '.pptx', '.key']);

/** 扫描时跳过的目录（开发产物、备份，本来就不该上线） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '_backup', '_shots', 'shots', '.work', 'dist',
  '__MACOSX', '.idea', '.vscode'
]);

/** GitHub 单文件硬限制 100MB */
const MAX_SINGLE_FILE = 100 * 1024 * 1024;
/** 总大小提醒阈值：视频多了首次 push 会很慢 */
const WARN_TOTAL_SIZE = 100 * 1024 * 1024;

const IMAGE_MAX_EDGE_RECOMMEND = 4000;

/* ------------------------------------------------------------ 分类 */

function classify(ext) {
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (DESIGN_EXT.has(ext)) return 'design';
  if (DOC_EXT.has(ext)) return 'doc';
  return 'other';
}

/* ------------------------------------------------------------ 文件名检查（C1） */

/**
 * 判断文件名是否可以安全上线。
 * 允许：字母、数字、点、下划线、短横线。其余一律视为风险。
 */
function checkName(name) {
  const issues = [];
  if (/[^\x20-\x7e]/.test(name)) issues.push('含中文或非 ASCII 字符');
  if (/\s/.test(name)) issues.push('含空格');
  if (/[^A-Za-z0-9._-]/.test(name.replace(/[^\x20-\x7e]/g, ''))) issues.push('含特殊字符');
  if (/[A-Z]/.test(name)) issues.push('含大写字母（大小写敏感平台上易错）');
  if (name.length > 80) issues.push('文件名过长');
  return { safe: issues.length === 0, issues };
}

/**
 * 产出安全文件名：保 ASCII，去掉风险字符，冲突时补序号。
 * 折叠后为空（纯中文名）则退化为 `{kind}-{序号}`，并把映射写进清单。
 */
function suggestName(originalName, kind, seq, used) {
  const ext = path.extname(originalName).toLowerCase();
  const stem = originalName.slice(0, originalName.length - ext.length);

  let base = stem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  const fallbackSeq = String(seq).padStart(2, '0');

  // 判断这个名字还有没有「可信的语义残留」：
  //  - 「网页3.png」折叠后只剩数字 → 无意义
  //  - 「《AI绘梦，众手筑蓝》.mp4」折叠后只剩 ai → 比没有更糟（看起来像另一部片子）
  //  - 「AI广告宣传片.mp4」折叠后只剩 ai-2 → 同上
  // 规则：中文占比过高，或残留的英文字母少于 3 个，就老实退化为序号命名，
  //       并在清单里保留原名映射，让人能追溯。
  const stemChars = [...stem];
  const cjkCount = stemChars.filter((ch) => {
    const c = ch.codePointAt(0);
    return c >= 0x2e80 && c <= 0x9fff;
  }).length;
  const asciiLetters = (stem.match(/[A-Za-z]/g) || []).length;
  const cjkRatio = stemChars.length ? cjkCount / stemChars.length : 0;
  const semanticSurvives = asciiLetters >= 3 && cjkRatio <= 0.4;

  if (!base || !/[a-z]/.test(base) || /^[0-9-]+$/.test(base) || !semanticSurvives) {
    base = kind + '-' + fallbackSeq;
  }
  if (base.length > 60) base = base.slice(0, 60).replace(/-+$/g, '');
  if (/^[0-9]/.test(base)) base = kind + '-' + base;

  let candidate = base + ext;
  let n = 2;
  while (used.has(candidate)) {
    candidate = base + '-' + n + ext;
    n++;
  }
  used.add(candidate);
  return candidate;
}

/* ------------------------------------------------------------ 图片尺寸（零依赖） */

/**
 * 手写读取图片宽高，支持 PNG / JPEG / GIF / WebP / BMP。
 * 解析不出来返回 null（SVG 等矢量图没有固定像素尺寸）。
 */
async function readImageSize(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const head = Buffer.alloc(32);
    const { bytesRead } = await fh.read(head, 0, 32, 0);
    if (bytesRead < 12) return null;

    // PNG: 8 字节签名 + IHDR
    if (head.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20), format: 'png' };
    }

    // GIF: GIF87a / GIF89a + 逻辑屏幕描述符
    const sig6 = head.toString('latin1', 0, 6);
    if (sig6 === 'GIF87a' || sig6 === 'GIF89a') {
      return { width: head.readUInt16LE(6), height: head.readUInt16LE(8), format: 'gif' };
    }

    // BMP
    if (head.toString('latin1', 0, 2) === 'BM') {
      return { width: head.readInt32LE(18), height: Math.abs(head.readInt32LE(22)), format: 'bmp' };
    }

    // WebP: RIFF....WEBP
    if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
      const chunk = head.toString('latin1', 12, 16);
      if (chunk === 'VP8X' && bytesRead >= 30) {
        const w = 1 + (head[24] | (head[25] << 8) | (head[26] << 16));
        const h = 1 + (head[27] | (head[28] << 8) | (head[29] << 16));
        return { width: w, height: h, format: 'webp' };
      }
      if (chunk === 'VP8 ' && bytesRead >= 30) {
        return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff, format: 'webp' };
      }
      if (chunk === 'VP8L' && bytesRead >= 25) {
        const b = head.slice(21, 25);
        const bits = b.readUInt32LE(0);
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1,
          format: 'webp'
        };
      }
      return null;
    }

    // JPEG: 逐段找 SOFn
    if (head[0] === 0xff && head[1] === 0xd8) {
      await fh.close();
      fh = null;
      return await readJpegSize(file);
    }

    return null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function readJpegSize(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const stat = await fh.stat();
    let pos = 2;
    for (let guard = 0; guard < 5000 && pos < stat.size; guard++) {
      const b = Buffer.alloc(4);
      const { bytesRead } = await fh.read(b, 0, 4, pos);
      if (bytesRead < 2) return null;
      if (b[0] !== 0xff) {
        pos++;
        continue;
      }
      const marker = b[1];
      // SOF0..SOF15，排除 DHT(0xc4) / JPG(0xc8) / DAC(0xcc)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        // 段结构：FF Cn | 长度(2) | 精度(1) | 高(2) | 宽(2)
        const seg = Buffer.alloc(10);
        const r = await fh.read(seg, 0, 10, pos);
        if (r.bytesRead < 9) return null;
        return { width: seg.readUInt16BE(7), height: seg.readUInt16BE(5), format: 'jpeg' };
      }
      // 独立标记（无长度字段）
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        pos += 2;
        continue;
      }
      const lenBuf = Buffer.alloc(2);
      await fh.read(lenBuf, 0, 2, pos + 2);
      const len = lenBuf.readUInt16BE(0);
      if (len < 2) return null;
      pos += 2 + len;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/* ------------------------------------------------------------ 视频编码（C2，手写 MP4 解析） */

/** 读一个 box 头，返回大小与类型 */
async function readBoxHeader(fh, pos) {
  const buf = Buffer.alloc(16);
  const { bytesRead } = await fh.read(buf, 0, 16, pos);
  if (bytesRead < 8) return null;
  let size = buf.readUInt32BE(0);
  const type = buf.toString('latin1', 4, 8);
  let headerSize = 8;
  if (size === 1) {
    if (bytesRead < 16) return null;
    size = Number(buf.readBigUInt64BE(8));
    headerSize = 16;
  } else if (size === 0) {
    size = Infinity;
  }
  if (size < headerSize) return null;
  return { size, type, headerSize };
}

/** 在 [start,end) 区间内递归找 stsd 并取出条目 fourcc */
async function findStsdCodecs(fh, start, end, depth = 0) {
  if (depth > 6) return [];
  let pos = start;
  const found = [];

  while (pos < end) {
    const box = await readBoxHeader(fh, pos);
    if (!box) break;

    // 只往容器盒里钻，mdat 这种大块直接跳过（避免读整个视频）
    const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'moof', 'traf']);
    if (box.type === 'stsd') {
      const head = Buffer.alloc(16);
      await fh.read(head, 0, 16, pos + box.headerSize);
      // stsd 是 FullBox：4 字节 version/flags + 4 字节 entry_count，然后每个条目 4 字节 size + 4 字节 fourcc
      const entryCount = head.readUInt32BE(4);
      let entryPos = pos + box.headerSize + 8;
      for (let i = 0; i < Math.min(entryCount, 8); i++) {
        const eh = Buffer.alloc(8);
        const { bytesRead } = await fh.read(eh, 0, 8, entryPos);
        if (bytesRead < 8) break;
        const entrySize = eh.readUInt32BE(0);
        const fourcc = eh.toString('latin1', 4, 8);
        if (/^[a-z0-9]{4}$/i.test(fourcc)) found.push(fourcc);
        if (entrySize < 8) break;
        entryPos += entrySize;
      }
      return found;
    }

    if (CONTAINERS.has(box.type) && Number.isFinite(box.size)) {
      const inner = await findStsdCodecs(fh, pos + box.headerSize, pos + box.size, depth + 1);
      if (inner.length) return inner;
    }

    if (!Number.isFinite(box.size)) break;
    pos += box.size;
  }

  return found;
}

/**
 * 读取 MP4/MOV 的视频编码。
 * @returns {Promise<{codec:string, family:'h264'|'hevc'|'other'|'unknown', browserPlayable:boolean}|null>}
 */
async function readVideoCodec(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const stat = await fh.stat();
    const codecs = await findStsdCodecs(fh, 0, stat.size);
    if (!codecs.length) return { codec: 'unknown', family: 'unknown', browserPlayable: false };

    const lower = codecs.map((c) => c.toLowerCase());
    const pick = (list) => lower.find((c) => list.includes(c));

    const hevc = pick(['hvc1', 'hev1', 'hvc2', 'dvhe', 'dvh1']);
    if (hevc) return { codec: hevc, family: 'hevc', browserPlayable: false };

    const avc = pick(['avc1', 'avc3', 'avc2']);
    if (avc) return { codec: avc, family: 'h264', browserPlayable: true };

    const vp = pick(['vp09', 'vp08']);
    if (vp) return { codec: vp, family: 'other', browserPlayable: true };

    const av1 = pick(['av01']);
    if (av1) return { codec: av1, family: 'other', browserPlayable: true };

    return { codec: lower[0], family: 'other', browserPlayable: false };
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/* ------------------------------------------------------------ 外部工具探测 */

/** 探测某个可执行命令是否在 PATH 上（不下载、不安装） */
async function which(cmd) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        await fsp.access(full, fs.constants.X_OK);
        return full;
      } catch {
        /* 继续找 */
      }
    }
  }
  return '';
}

/* ------------------------------------------------------------ 文件指纹（用于查重） */

/** 大小 + 头部 64KB 的 md5：足够识别「同一张图的不同副本」，且不用整读大文件 */
async function quickHash(file, size) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const len = Math.min(65536, Number(size) || 65536);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    const h = crypto.createHash('md5');
    h.update(String(size));
    h.update(buf.slice(0, bytesRead));
    return h.digest('hex');
  } catch {
    return '';
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/* ------------------------------------------------------------ 扫描 */

async function walk(dir, out, depth = 0) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
      if (e.name.startsWith('.')) continue;
      await walk(full, out, depth + 1);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 扫描素材来源目录，给出每个文件的事实（不含任何改写动作）。
 *
 * @param {string} dir
 * @param {{withHash?:boolean, withCodec?:boolean}} [opts]
 * @returns {Promise<{root:string, files:object[], stats:object, tools:object}>}
 */
async function scanSources(dir, opts = {}) {
  const root = path.resolve(dir);
  const st = await util.statSafe(root);
  if (!st || !st.isDirectory()) {
    throw new Error('素材目录不存在或不是目录：' + root);
  }

  const paths = await walk(root, []);
  const files = [];
  const totals = { count: 0, bytes: 0, image: 0, video: 0, audio: 0, design: 0, doc: 0, other: 0 };
  const hashMap = new Map();

  for (let i = 0; i < paths.length; i++) {
    const full = paths[i];
    const info = await util.statSafe(full);
    if (!info) continue;

    const name = path.basename(full);
    const ext = path.extname(name).toLowerCase();
    const kind = classify(ext);
    const rel = util.relPosix(root, full);
    const nameCheck = checkName(name);

    const record = {
      path: full,
      rel,
      name,
      ext,
      kind,
      size: info.size,
      sizeText: util.humanBytes(info.size),
      nameSafe: nameCheck.safe,
      nameIssues: nameCheck.issues,
      oversize: info.size > MAX_SINGLE_FILE,
      dims: null,
      video: null,
      hash: '',
      duplicateOf: ''
    };

    if (kind === 'image' && ext !== '.svg') {
      record.dims = await readImageSize(full);
    }
    if (kind === 'video' && opts.withCodec !== false) {
      record.video = await readVideoCodec(full);
    }
    if (opts.withHash !== false && (kind === 'image' || kind === 'video')) {
      record.hash = await quickHash(full, info.size);
      if (record.hash) {
        if (hashMap.has(record.hash)) record.duplicateOf = hashMap.get(record.hash);
        else hashMap.set(record.hash, rel);
      }
    }

    totals.count++;
    totals.bytes += info.size;
    totals[kind] = (totals[kind] || 0) + 1;
    files.push(record);
  }

  files.sort((a, b) => (a.kind === b.kind ? b.size - a.size : a.kind.localeCompare(b.kind)));

  const tools = {
    ffmpeg: await which('ffmpeg'),
    magick: await which('magick')
  };

  return { root, files, stats: totals, tools };
}

/* ------------------------------------------------------------ 出计划（不改文件） */

/**
 * 依据扫描结果产出「素材规整计划」：改名映射 + 阻塞项 + 警告 + 待办。
 * 这一步**绝不改任何文件**，先让用户看清楚要发生什么。
 *
 * @param {object} scan scanSources() 的结果
 * @param {{outName?:string}} [opts]
 */
function planAssets(scan, opts = {}) {
  const outName = opts.outName || 'assets';
  const used = new Set();
  const renames = [];
  const copyList = [];
  const blockers = [];
  const warnings = [];
  const todos = [];
  const skipped = [];

  const seq = { image: 0, video: 0, audio: 0, design: 0, doc: 0, other: 0 };

  for (const f of scan.files) {
    // 源工程和文档不进 assets，但要把问题讲清楚
    if (f.kind === 'design') {
      warnings.push({
        code: 'C3',
        file: f.rel,
        message:
          f.ext === '.psd' || f.ext === '.psb'
            ? 'PSD 源工程无法直接网页展示，需导出预览图（png/jpg）后再入库'
            : 'AEP/AI 等工程文件无法直接网页展示，建议只在技能标签里佐证，不要放进 assets'
      });
      continue;
    }
    if (f.kind === 'doc' || f.kind === 'other') {
      // 文档（简历 docx / 说明 md / 计划）和 HTML/JS 等代码文件不进 assets。
      // 但要记下来：简历类文档是「取材来源」，需要在生成阶段读它。
      skipped.push({ rel: f.rel, kind: f.kind, size: f.size, sizeText: util.humanBytes(f.size) });
      continue;
    }

    seq[f.kind] = (seq[f.kind] || 0) + 1;
    const target = f.nameSafe ? f.name.toLowerCase() : suggestName(f.name, f.kind, seq[f.kind], used);
    if (f.nameSafe) used.add(target);

    if (target !== f.name) {
      renames.push({ from: f.rel, to: outName + '/' + target, reason: f.nameIssues.join('；') || '文件名需规范化' });
    }
    copyList.push({ from: f.path, rel: f.rel, to: target, kind: f.kind, size: f.size });

    // C2 视频编码
    if (f.kind === 'video' && f.video) {
      if (!f.video.browserPlayable) {
        const isHevc = f.video.family === 'hevc';
        blockers.push({
          code: 'C2',
          file: f.rel,
          message: isHevc
            ? `视频编码为 ${f.video.codec.toUpperCase()}（HEVC），浏览器无法播放，必须转 H.264`
            : `视频编码为 ${f.video.codec}，浏览器兼容性未知，建议转 H.264`,
          command: scan.tools.ffmpeg
            ? `ffmpeg -i "${f.rel}" -c:v libx264 -crf 23 -preset medium -c:a aac -movflags +faststart "${outName}/${target}"`
            : '未检测到 ffmpeg，请先安装（winget install Gyan.FFmpeg）后重试'
        });
      } else {
        // C4 首帧封面
        todos.push({
          code: 'C4',
          file: f.rel,
          message: '需要抽首帧作封面（视频灯箱黑屏兜底）',
          command: scan.tools.ffmpeg
            ? `ffmpeg -y -ss 1 -i "${f.rel}" -frames:v 1 "${outName}/${path.basename(target, path.extname(target))}-poster.jpg"`
            : '未检测到 ffmpeg，无法自动抽帧'
        });
      }
    }

    // 单文件超限
    if (f.oversize) {
      blockers.push({
        code: 'LIMIT',
        file: f.rel,
        message: `单文件 ${f.sizeText} 超过 GitHub 单文件 100MB 硬限制，push 会被拒绝`,
        command: f.kind === 'video' ? '压缩码率或转码降分辨率' : '压缩后再放入 assets'
      });
    }

    // 重复素材
    if (f.duplicateOf) {
      warnings.push({
        code: 'DUP',
        file: f.rel,
        message: `与 ${f.duplicateOf} 内容相同（快速指纹一致），可只保留一份以减小体积`
      });
    }

    // 图片过大
    if (f.dims && Math.max(f.dims.width, f.dims.height) > IMAGE_MAX_EDGE_RECOMMEND) {
      warnings.push({
        code: 'BIG',
        file: f.rel,
        message: `图片 ${f.dims.width}×${f.dims.height} 偏大，建议压到长边 ≤${IMAGE_MAX_EDGE_RECOMMEND}px 以加快加载`
      });
    }
  }

  // C5：图片必须能被静态引用 —— 这里只做提示，实际校验在 selfcheck
  const images = copyList.filter((c) => c.kind === 'image');
  if (images.length === 0 && copyList.length > 0) {
    warnings.push({ code: 'C5', file: '', message: '没有任何图片素材，页面可能是纯文字版式' });
  }

  if (scan.stats.bytes > WARN_TOTAL_SIZE) {
    warnings.push({
      code: 'SIZE',
      file: '',
      message: `素材合计 ${util.humanBytes(scan.stats.bytes)}，首次 push 会比较慢（视频建议压到 100MB 以内）`
    });
  }

  return {
    root: scan.root,
    outName,
    renames,
    copyList,
    blockers,
    warnings,
    todos,
    skipped,
    stats: {
      total: scan.files.length,
      willCopy: copyList.length,
      bytes: copyList.reduce((s, c) => s + c.size, 0)
    },
    tools: scan.tools
  };
}

/* ------------------------------------------------------------ 执行计划 */

/**
 * 按计划把素材复制进目标目录，并写出改名映射清单。
 * @param {object} plan planAssets() 的结果
 * @param {{outDir:string, dryRun?:boolean}} opts
 */
async function applyPlan(plan, opts) {
  const outDir = path.resolve(opts.outDir);
  const dryRun = !!opts.dryRun;
  const copied = [];

  if (!dryRun) await util.ensureDir(outDir);

  for (const item of plan.copyList) {
    const target = path.join(outDir, item.to);
    if (!dryRun) {
      await util.ensureDir(path.dirname(target));
      await fsp.copyFile(item.from, target);
    }
    copied.push({ from: item.rel, to: item.to, size: item.size, sizeText: util.humanBytes(item.size) });
  }

  const manifest = {
    generatedAt: util.nowIso(),
    sourceRoot: plan.root,
    outDir: dryRun ? '(dry-run)' : outDir,
    renamed: plan.renames,
    files: copied,
    blockers: plan.blockers,
    warnings: plan.warnings
  };

  if (!dryRun) {
    await fsp.writeFile(
      path.join(outDir, 'assets-manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );
  }

  return manifest;
}

/* ------------------------------------------------------------ 人读报告 */

function formatPlan(plan) {
  const L = [];
  L.push('素材规整计划');
  L.push('  来源：' + plan.root);
  L.push('  目标目录：' + plan.outName + '/');
  L.push('  待复制：' + plan.stats.willCopy + ' 个文件，合计 ' + util.humanBytes(plan.stats.bytes));
  L.push('');

  if (plan.renames.length) {
    L.push('需要改名（C1：文件名必须 ASCII / 无空格）');
    for (const r of plan.renames.slice(0, 40)) {
      L.push('  ' + r.from + '  →  ' + r.to);
      L.push('      原因：' + r.reason);
    }
    if (plan.renames.length > 40) L.push('  …还有 ' + (plan.renames.length - 40) + ' 项');
    L.push('');
  }

  if (plan.blockers.length) {
    L.push('阻塞项（必须处理后才能正常上线）');
    for (const b of plan.blockers) {
      L.push('  [' + b.code + '] ' + (b.file || '') );
      L.push('      ' + b.message);
      if (b.command) L.push('      处理：' + b.command);
    }
    L.push('');
  }

  if (plan.todos.length) {
    L.push('待办（不阻塞，但建议做）');
    for (const t of plan.todos) {
      L.push('  [' + t.code + '] ' + t.file);
      L.push('      ' + t.message);
      if (t.command) L.push('      命令：' + t.command);
    }
    L.push('');
  }

  if (plan.skipped && plan.skipped.length) {
    L.push('不进入 assets（文档 / 代码，但取材阶段可能要读）');
    for (const s of plan.skipped.slice(0, 20)) L.push('  ' + s.rel + '  ' + s.sizeText);
    if (plan.skipped.length > 20) L.push('  …还有 ' + (plan.skipped.length - 20) + ' 项');
    L.push('');
  }

  if (plan.warnings.length) {
    L.push('提醒');
    for (const w of plan.warnings) {
      L.push('  [' + w.code + '] ' + (w.file ? w.file + '：' : '') + w.message);
    }
    L.push('');
  }

  L.push('外部工具：ffmpeg ' + (plan.tools.ffmpeg ? '已就绪' : '未安装') +
         ' / ImageMagick ' + (plan.tools.magick ? '已就绪' : '未安装'));

  return L.join('\n');
}

function formatScan(scan) {
  const L = [];
  L.push('素材扫描');
  L.push('  目录：' + scan.root);
  L.push(
    '  共 ' + scan.stats.count + ' 个文件，合计 ' + util.humanBytes(scan.stats.bytes) +
      '（图片 ' + (scan.stats.image || 0) + ' / 视频 ' + (scan.stats.video || 0) +
      ' / 工程 ' + (scan.stats.design || 0) + ' / 文档 ' + (scan.stats.doc || 0) + '）'
  );
  L.push('');

  const risky = scan.files.filter((f) => !f.nameSafe);
  if (risky.length) {
    L.push('文件名有风险（' + risky.length + ' 个）');
    for (const f of risky.slice(0, 20)) {
      L.push('  ' + f.rel + '  ← ' + f.nameIssues.join('、'));
    }
    L.push('');
  }

  const videos = scan.files.filter((f) => f.kind === 'video' && f.video);
  if (videos.length) {
    L.push('视频编码');
    for (const f of videos) {
      const v = f.video;
      L.push('  ' + f.rel + '  → ' + v.codec + '，' + (v.browserPlayable ? '浏览器可播' : '浏览器播不了，需转码') + '，' + f.sizeText);
    }
    L.push('');
  }

  const designs = scan.files.filter((f) => f.kind === 'design');
  if (designs.length) {
    L.push('源工程（无法直接展示）');
    for (const f of designs) L.push('  ' + f.rel + '  ' + f.sizeText);
    L.push('');
  }

  return L.join('\n');
}

module.exports = {
  IMAGE_EXT,
  VIDEO_EXT,
  DESIGN_EXT,
  DOC_EXT,
  SKIP_DIRS,
  MAX_SINGLE_FILE,
  classify,
  checkName,
  suggestName,
  readImageSize,
  readVideoCodec,
  quickHash,
  which,
  scanSources,
  planAssets,
  applyPlan,
  formatScan,
  formatPlan
};
