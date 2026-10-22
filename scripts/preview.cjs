#!/usr/bin/env node
'use strict';
/**
 * 本地预览：node scripts/preview.cjs <站点目录> [--port 34567]
 * 起一个静态服务（支持视频 Range 请求），Ctrl+C 停止。
 */

const path = require('path');
const previewLib = require('../lib/preview');

const args = process.argv.slice(2);
const positional = [];
let port = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (!args[i].startsWith('--')) positional.push(args[i]);
}

const dir = positional[0];
if (!dir) {
  console.error('用法：node scripts/preview.cjs <站点目录> [--port 34567]');
  process.exit(2);
}

(async () => {
  const res = await previewLib.start({ dir: path.resolve(dir), port: port || undefined, onLog: (l, m) => console.log('  [' + l + '] ' + m) });
  if (!res.ok) {
    console.error('预览启动失败：' + (res.error && res.error.message));
    process.exit(1);
  }
  console.log('预览地址：' + res.url);
  console.log('按 Ctrl+C 停止');
  process.on('SIGINT', async () => {
    await previewLib.stop();
    process.exit(0);
  });
})().catch((e) => {
  console.error('出错：' + (e && e.message ? e.message : e));
  process.exit(1);
});
