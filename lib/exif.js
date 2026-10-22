'use strict';
/**
 * 图片元数据处理（零依赖）。
 *
 * 为什么需要它：很多「个人作品集」里放的手机拍摄照片会在 EXIF 里带着
 * 拍摄设备、拍摄时间、甚至 GPS 经纬度；证件照还常带作者名 / 版权字段。
 * 这些信息肉眼看不见，但一上线就随图片公开了，属于典型的隐形隐私泄露。
 *
 * 能力：
 *   - 读出 JPEG 的 EXIF（型号 / 软件 / 时间 / 作者 / 描述 / 版权 / GPS）
 *   - 无损剥离 JPEG 的 APPn 与 COM 段（不重新编码，画质零损失）
 *   - 剥离 PNG 的 tEXt / iTXt / zTXt / eXIf 文本块
 *   - 读取常见图片格式的宽高（用于生成同比例占位图）
 */

/* --------------------------------------------------------------- 尺寸 */

function imageSize(buf) {
  try {
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'png' };
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const segLen = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), type: 'jpeg' };
        }
        i += 2 + segLen;
      }
      return null;
    }
    if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'GIF') {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), type: 'gif' };
    }
    if (buf.length > 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
      const fourcc = buf.toString('latin1', 12, 16);
      if (fourcc === 'VP8X') return { w: (buf.readUIntLE(24, 3) & 0xffffff) + 1, h: (buf.readUIntLE(27, 3) & 0xffffff) + 1, type: 'webp' };
      if (fourcc === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, type: 'webp' };
      if (fourcc === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1, type: 'webp' };
      }
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) return { w: 0, h: 0, type: 'jpeg' };
    return null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- EXIF */

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function readTiffValue(buf, le, entryOff, tiffBase) {
  const type = le ? buf.readUInt16LE(entryOff + 2) : buf.readUInt16BE(entryOff + 2);
  const count = le ? buf.readUInt32LE(entryOff + 4) : buf.readUInt32BE(entryOff + 4);
  const size = (TYPE_SIZE[type] || 1) * count;
  const valOff = size > 4 ? tiffBase + (le ? buf.readUInt32LE(entryOff + 8) : buf.readUInt32BE(entryOff + 8)) : entryOff + 8;
  if (valOff < 0 || valOff + size > buf.length) return null;
  const readOne = (o, idx) => {
    switch (type) {
      case 1:
      case 7:
        return buf.readUInt8(o + idx);
      case 2:
        return buf.toString('latin1', o, o + count).replace(/\0.*$/, '').trim();
      case 3:
        return le ? buf.readUInt16LE(o + idx * 2) : buf.readUInt16BE(o + idx * 2);
      case 4:
        return le ? buf.readUInt32LE(o + idx * 4) : buf.readUInt32BE(o + idx * 4);
      case 5: {
        const num = le ? buf.readUInt32LE(o + idx * 8) : buf.readUInt32BE(o + idx * 8);
        const den = le ? buf.readUInt32LE(o + idx * 8 + 4) : buf.readUInt32BE(o + idx * 8 + 4);
        return den ? num / den : 0;
      }
      case 9:
        return le ? buf.readInt32LE(o + idx * 4) : buf.readInt32BE(o + idx * 4);
      case 10: {
        const num = le ? buf.readInt32LE(o + idx * 8) : buf.readInt32BE(o + idx * 8);
        const den = le ? buf.readInt32LE(o + idx * 8 + 4) : buf.readInt32BE(o + idx * 8 + 4);
        return den ? num / den : 0;
      }
      default:
        return null;
    }
  };
  if (type === 2) return readOne(valOff, 0);
  if (count === 1) return readOne(valOff, 0);
  const arr = [];
  for (let i = 0; i < Math.min(count, 16); i++) arr.push(readOne(valOff, i));
  return arr;
}

function readIfd(buf, le, ifdOff, tiffBase) {
  const map = {};
  if (ifdOff <= 0 || ifdOff + 2 > buf.length) return map;
  const count = le ? buf.readUInt16LE(ifdOff) : buf.readUInt16BE(ifdOff);
  if (count > 512) return map;
  for (let i = 0; i < count; i++) {
    const e = ifdOff + 2 + i * 12;
    if (e + 12 > buf.length) break;
    const tag = le ? buf.readUInt16LE(e) : buf.readUInt16BE(e);
    const v = readTiffValue(buf, le, e, tiffBase);
    if (v !== null && v !== undefined && v !== '') map[tag] = v;
  }
  return map;
}

/** 解析 JPEG 的 EXIF，返回结构化信息 */
function parseJpegExif(buf) {
  const out = { hasExif: false, exif: {}, gps: null, raw: null };
  try {
    if (!(buf[0] === 0xff && buf[1] === 0xd8)) return out;
    let i = 2;
    let app1 = null;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      if (marker === 0xda) break; // 图像数据开始
      const segLen = buf.readUInt16BE(i + 2);
      if (marker === 0xe1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
        app1 = { start: i + 10, end: i + 2 + segLen };
        break;
      }
      i += 2 + segLen;
    }
    if (!app1) return out;
    const tiffBase = app1.start;
    const order = buf.toString('latin1', tiffBase, tiffBase + 2);
    const le = order === 'II';
    if (!le && order !== 'MM') return out;
    out.hasExif = true;
    const magic = le ? buf.readUInt16LE(tiffBase + 2) : buf.readUInt16BE(tiffBase + 2);
    if (magic !== 42) return out;
    const ifd0Off = tiffBase + (le ? buf.readUInt32LE(tiffBase + 4) : buf.readUInt32BE(tiffBase + 4));
    const ifd0 = readIfd(buf, le, ifd0Off, tiffBase);

    const pick = (v) => (Array.isArray(v) ? v[0] : v);
    const exif = {};
    if (ifd0[0x010f]) exif.make = String(pick(ifd0[0x010f]));
    if (ifd0[0x0110]) exif.model = String(pick(ifd0[0x0110]));
    if (ifd0[0x0131]) exif.software = String(pick(ifd0[0x0131]));
    if (ifd0[0x0132]) exif.datetime = String(pick(ifd0[0x0132]));
    if (ifd0[0x010e]) exif.description = String(pick(ifd0[0x010e]));
    if (ifd0[0x013b]) exif.artist = String(pick(ifd0[0x013b]));
    if (ifd0[0x8298]) exif.copyright = String(pick(ifd0[0x8298]));
    if (ifd0[0x0112]) exif.orientation = pick(ifd0[0x0112]);
    out.exif = JSON.parse(JSON.stringify(exif));

    // GPS IFD
    const gpsOff = ifd0[0x8825];
    if (gpsOff) {
      const gps = readIfd(buf, le, tiffBase + gpsOff, tiffBase);
      const toDeg = (arr) => (Array.isArray(arr) && arr.length >= 3 ? arr[0] + arr[1] / 60 + arr[2] / 3600 : null);
      let lat = toDeg(gps[2]);
      let lng = toDeg(gps[4]);
      const latRef = gps[1] ? String(gps[1]).toUpperCase() : 'N';
      const lngRef = gps[3] ? String(gps[3]).toUpperCase() : 'E';
      if (lat !== null && latRef.startsWith('S')) lat = -lat;
      if (lng !== null && lngRef.startsWith('W')) lng = -lng;
      if (lat !== null && lng !== null) out.gps = { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
    }
    out.raw = Object.keys(exif).length;
    return out;
  } catch {
    return out;
  }
}

/** 无损剥离 JPEG 的 APPn（保留 APP0/JFIF）与 COM 注释段 */
function stripJpegMetadata(buf) {
  try {
    if (!(buf[0] === 0xff && buf[1] === 0xd8)) return buf;
    const parts = [buf.slice(0, 2)];
    let i = 2;
    let removed = 0;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        parts.push(buf.slice(i, i + 2));
        i += 2;
        continue;
      }
      const segLen = buf.readUInt16BE(i + 2);
      const segEnd = i + 2 + segLen;
      if (segEnd > buf.length) break;
      const isApp0 = marker === 0xe0;
      const isAppN = marker >= 0xe1 && marker <= 0xef;
      const isCom = marker === 0xfe;
      if (isAppN || isCom) {
        removed++;
      } else {
        parts.push(buf.slice(i, segEnd));
      }
      i = segEnd;
      if (marker === 0xda) break; // SOS 之后是压缩数据
    }
    if (i < buf.length) parts.push(buf.slice(i));
    const out = Buffer.concat(parts);
    Object.defineProperty(out, '__removedSegments', { value: removed, enumerable: false });
    return out;
  } catch {
    return buf;
  }
}

/** 剥离 PNG 的文本 / EXIF 块 */
function stripPngMetadata(buf) {
  try {
    if (buf.readUInt32BE(0) !== 0x89504e47) return buf;
    const parts = [buf.slice(0, 8)];
    let i = 8;
    let removed = 0;
    const DROP = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']);
    while (i + 8 <= buf.length) {
      const len = buf.readUInt32BE(i);
      const type = buf.toString('latin1', i + 4, i + 8);
      const end = i + 12 + len;
      if (end > buf.length) break;
      if (DROP.has(type)) removed++;
      else parts.push(buf.slice(i, end));
      i = end;
      if (type === 'IEND') break;
    }
    if (i < buf.length && parts.length) parts.push(buf.slice(i));
    const out = Buffer.concat(parts);
    Object.defineProperty(out, '__removedChunks', { value: removed, enumerable: false });
    return out;
  } catch {
    return buf;
  }
}

/** PNG 文本块里的可读信息（可能含作者名） */
function parsePngText(buf) {
  const found = [];
  try {
    if (buf.readUInt32BE(0) !== 0x89504e47) return found;
    let i = 8;
    while (i + 8 <= buf.length) {
      const len = buf.readUInt32BE(i);
      const type = buf.toString('latin1', i + 4, i + 8);
      const end = i + 12 + len;
      if (end > buf.length) break;
      if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
        const body = buf.slice(i + 8, i + 8 + len).toString('latin1').replace(/\0/g, ' | ');
        found.push({ type, text: body.slice(0, 200) });
      }
      i = end;
      if (type === 'IEND') break;
    }
  } catch {
    /* ignore */
  }
  return found;
}

/** 综合分析一张图片的元数据 */
function inspectImage(buf, ext) {
  const e = String(ext || '').toLowerCase();
  const size = imageSize(buf);
  if (e === '.jpg' || e === '.jpeg') {
    const meta = parseJpegExif(buf);
    return { ...meta, size, kind: 'jpeg' };
  }
  if (e === '.png') {
    const texts = parsePngText(buf);
    return { hasExif: texts.length > 0, exif: texts.length ? { description: texts.map((t) => t.text).join(' ; ') } : {}, gps: null, size, kind: 'png', texts };
  }
  return { hasExif: false, exif: {}, gps: null, size, kind: 'other' };
}

module.exports = {
  imageSize,
  parseJpegExif,
  stripJpegMetadata,
  stripPngMetadata,
  parsePngText,
  inspectImage
};
