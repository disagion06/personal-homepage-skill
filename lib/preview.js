'use strict';
/**
 * 本地预览：把生成好的目录用 HTTP 服务起来（不是 file://，这样相对路径、fetch、
 * 视频 Range 请求的行为都和线上一致），浏览器打开 http://127.0.0.1:port/。
 */
const http = require('http');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const { toPosix } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm'
};

let server = null;
let current = { port: null, dir: null, url: null };

/** 启动静态预览服务 */
async function start({ dir, port = 0, onLog }) {
  if (server) await stop();
  const root = path.resolve(dir);
  const st = await fsp.stat(root).catch(() => null);
  if (!st || !st.isDirectory()) {
    return { ok: false, error: { code: 'E_NOT_FOUND', message: '目录不存在：' + root } };
  }

  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const target = path.join(root, rel);
      // 防目录穿越
      if (!path.resolve(target).toLowerCase().startsWith(root.toLowerCase())) {
        res.writeHead(403).end('403 Forbidden');
        return;
      }
      let file = target;
      let stat = await fsp.stat(file).catch(() => null);
      if (stat && stat.isDirectory()) {
        file = path.join(file, 'index.html');
        stat = await fsp.stat(file).catch(() => null);
      }
      if (!stat || !stat.isFile()) {
        // 找不到就回退到 index.html（单页应用友好）
        const fallback = path.join(root, 'index.html');
        if (await fsp.stat(fallback).catch(() => null)) {
          file = fallback;
          stat = await fsp.stat(file);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found: ' + toPosix(rel));
          return;
        }
      }
      const ext = path.extname(file).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      const range = req.headers.range;
      if (range && /^bytes=/.test(range)) {
        const [s, e] = range.replace(/bytes=/, '').split('-');
        const start = parseInt(s, 10) || 0;
        const end = e ? parseInt(e, 10) : stat.size - 1;
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1
        });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' });
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 ' + e.message);
    }
  });

  const actualPort = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  }).catch((e) => {
    onLog && onLog('error', '预览服务启动失败：' + e.message);
    return null;
  });
  if (!actualPort) return { ok: false, error: { code: 'E_NET', message: '端口被占用或无法监听' } };

  current = { port: actualPort, dir: root, url: 'http://127.0.0.1:' + actualPort + '/' };
  onLog && onLog('ok', '本地预览已启动：' + current.url);
  return { ok: true, ...current };
}

async function stop() {
  if (!server) return { ok: true };
  await new Promise((resolve) => server.close(() => resolve()));
  server = null;
  current = { port: null, dir: null, url: null };
  return { ok: true };
}

function info() {
  return { ...current };
}

module.exports = { start, stop, info };
