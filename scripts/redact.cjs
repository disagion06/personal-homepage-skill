#!/usr/bin/env node
'use strict';
/**
 * 敏感信息扫描与脱敏。
 *
 *   node scripts/redact.cjs scan  <站点目录> [--json 文件]
 *   node scripts/redact.cjs build <站点目录> [--policy mask-all|mask-high|hide-all|keep-all]
 *                                [--interactive] [--exclude a,b] [--out 工作区]
 *
 * scan  只扫描并列清单，不改任何文件。
 * build 生成脱敏后的上线目录（不会修改原稿）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const scanner = require('../lib/scanner');
const redactor = require('../lib/redactor');
const util = require('../lib/util');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

const SEV = { high: '高危', medium: '中危', low: '低危' };

function printFindings(scan) {
  console.log('站点：' + scan.siteRoot + '（' + scan.stats.files + ' 个文件，' + util.humanBytes(scan.stats.bytes) + '）');
  console.log('');

  if (scan.findings.length) {
    console.log('文本敏感信息（' + scan.findings.length + ' 项，同类已按值聚合）');
    for (const f of scan.findings) {
      const occ = f.occurrences[0] || {};
      console.log(
        '  [' + (SEV[f.severity] || f.severity) + '] ' + String(f.ruleLabel).padEnd(14) +
        ' ' + String(f.value).slice(0, 40).padEnd(42) +
        ' ×' + String(f.count).padEnd(3) +
        ' → ' + f.maskPreview +
        '   @' + occ.file + ':' + occ.line
      );
    }
    console.log('');
  } else {
    console.log('文本敏感信息：0 项');
    console.log('');
  }

  if (scan.images.length) {
    console.log('图片（' + scan.images.length + ' 张）');
    for (const im of scan.images) {
      const tags = (im.tags || []).join(', ');
      console.log('  ' + String(im.rel).padEnd(40) + (tags ? '[' + tags + ']' : '') + (im.gps ? ' GPS ' + im.gps.lat + ',' + im.gps.lng : ''));
    }
    console.log('');
  }

  if (scan.suggestedExcludes.length) {
    console.log('建议排除（不上传）');
    for (const e of scan.suggestedExcludes) console.log('  ' + e.rel + '  ' + util.humanBytes(e.bytes) + '  — ' + e.reason);
    console.log('');
  }

  if (scan.warnings.length) {
    console.log('提醒');
    for (const w of scan.warnings) console.log('  ! ' + w);
    console.log('');
  }
}

function applyPolicy(scan, policy) {
  const decisions = {};
  const imageDecisions = {};
  for (const f of scan.findings) {
    if (policy === 'keep-all') decisions[f.id] = 'keep';
    else if (policy === 'mask-high') decisions[f.id] = f.severity === 'high' ? 'mask' : 'keep';
    else if (policy === 'hide-all') decisions[f.id] = 'hideblock';
    else decisions[f.id] = f.severity === 'low' ? 'keep' : 'mask';
  }
  for (const im of scan.images) {
    imageDecisions[im.id] = policy === 'keep-all' ? 'keep' : im.isPortrait ? 'mask' : 'keep';
  }
  return { decisions, imageDecisions };
}

async function askDecisions(scan) {
  const decisions = {};
  const imageDecisions = {};
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  console.log('\n逐项确认（回车 = 用括号里的默认值）');
  for (const f of scan.findings) {
    const def = f.defaultAction || 'mask';
    const ans = (await ask('  ' + f.ruleLabel + '「' + String(f.value).slice(0, 30) + '」 mask/delete/hideblock/keep (' + def + ')：')).trim();
    decisions[f.id] = ['mask', 'delete', 'hideblock', 'keep'].includes(ans) ? ans : def;
  }
  for (const im of scan.images) {
    const def = im.isPortrait ? 'mask' : 'keep';
    const ans = (await ask('  图片 ' + im.rel + ' mask/delete/keep (' + def + ')：')).trim();
    imageDecisions[im.id] = ['mask', 'delete', 'keep'].includes(ans) ? ans : def;
  }
  rl.close();
  return { decisions, imageDecisions };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const root = args._[1];

  if (!cmd || !root) {
    console.error('用法：node scripts/redact.cjs scan|build <站点目录> [选项]');
    process.exit(2);
  }

  const scan = await scanner.scan({ root, onLog: () => {} });
  if (!scan.ok) {
    console.error('扫描失败：' + (scan.error && scan.error.message));
    process.exit(1);
  }

  if (cmd === 'scan') {
    printFindings(scan);
    if (args.json) {
      fs.writeFileSync(path.resolve(args.json), JSON.stringify(scan, null, 2), 'utf8');
      console.log('结果已写入：' + path.resolve(args.json));
    }
    process.exit(0);
  }

  if (cmd !== 'build') {
    console.error('未知子命令：' + cmd + '（只支持 scan / build）');
    process.exit(2);
  }

  printFindings(scan);

  const payload = args.interactive ? await askDecisions(scan) : applyPolicy(scan, args.policy || 'mask-all');
  const exclude = args.exclude ? String(args.exclude).split(',').map((s) => s.trim()).filter(Boolean) : [];

  const res = await redactor.build({
    root,
    decisions: payload.decisions,
    imageDecisions: payload.imageDecisions,
    exclude,
    scanResult: scan,
    options: {
      workDir: args.out || path.join(os.homedir(), 'homepage-workspaces'),
      toolsDir: args.tools || null,
      stripExif: true,
      addNotice: false,
      siteTitle: args.title || null
    },
    onLog: (lvl, msg) => { if (lvl === 'warn' || lvl === 'error') console.log('  [' + lvl + '] ' + msg); },
    overwrite: true
  });

  if (!res.ok) {
    console.error('生成失败：' + (res.error && res.error.message));
    process.exit(1);
  }

  const ZH = { mask: '打码', delete: '删除', hideblock: '隐藏整块', keep: '保留' };
  console.log('\n脱敏完成');
  console.log('  上线目录：' + res.outDir);
  console.log('  文件：' + res.stats.files + ' 个 / ' + util.humanBytes(res.stats.bytes) + '，整块隐藏 ' + res.hiddenBlocks + ' 处');
  console.log('  已处理：');
  for (const a of res.applied.filter((x) => x.action !== 'keep')) {
    console.log('    ' + (ZH[a.action] || a.action).padEnd(6) + ' ' + String(a.ruleLabel).padEnd(14) + ' ' + String(a.value).slice(0, 30) + ' ×' + a.count);
  }
  const kept = res.applied.filter((x) => x.action === 'keep');
  if (kept.length) {
    console.log('  仍将公开（用户选择保留）：');
    for (const a of kept) console.log('    保留   ' + String(a.ruleLabel).padEnd(14) + ' ' + String(a.value).slice(0, 30) + ' ×' + a.count);
  }
  console.log('  脱敏报告：' + res.reportPath);
  if (res.leftover.length) {
    console.log('  ⚠ 自检未通过，仍有残留：' + res.leftover.map((l) => l.value).join('、'));
    process.exit(1);
  }
  console.log('  ✓ 自检通过：生成目录里没有漏网的敏感信息');
  console.log('\n下一步：node scripts/check-page.cjs "' + res.outDir + '"  然后  node scripts/deploy.cjs "' + res.outDir + '" --repo <仓库名>');
})().catch((e) => {
  console.error('出错：' + (e && e.message ? e.message : e));
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
