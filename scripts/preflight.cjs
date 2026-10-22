#!/usr/bin/env node
'use strict';
/**
 * 素材预检：node scripts/preflight.cjs <素材目录> [--apply <目标目录>]
 *
 * 只出计划，不改文件。加 --apply 才真正复制并改名。
 * 检查：文件名是否 ASCII、视频编码是否 H.264、是否有 PSD/AEP 等源工程、
 *       重复图片、过大的图片、超过 GitHub 100MB 限制的文件。
 */

const path = require('path');
const assets = require('../lib/assets');

const args = process.argv.slice(2);
const positional = [];
let applyTo = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') applyTo = args[++i];
  else if (!args[i].startsWith('--')) positional.push(args[i]);
}

const dir = positional[0];
if (!dir) {
  console.error('用法：node scripts/preflight.cjs <素材目录> [--apply <目标目录>]');
  process.exit(2);
}

(async () => {
  const scan = await assets.scanSources(dir);
  console.log(assets.formatScan(scan));
  const plan = assets.planAssets(scan, { outName: 'assets' });
  console.log(assets.formatPlan(plan));

  if (applyTo) {
    const manifest = await assets.applyPlan(plan, { outDir: path.resolve(applyTo) });
    console.log('\n已复制 ' + manifest.files.length + ' 个文件到 ' + path.resolve(applyTo));
    console.log('改名映射：' + path.join(path.resolve(applyTo), 'assets-manifest.json'));
  } else {
    console.log('\n（只是预检，未改动任何文件。确认无误后加 --apply <目标目录> 才执行）');
  }

  // 有阻塞项时用非 0 退出，方便 agent 判断要不要继续
  process.exit(plan.blockers.length ? 1 : 0);
})().catch((e) => {
  console.error('预检失败：' + (e && e.message ? e.message : e));
  process.exit(2);
});
