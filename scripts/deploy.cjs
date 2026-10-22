#!/usr/bin/env node
'use strict';
/**
 * 上线到 GitHub Pages：node scripts/deploy.cjs <目录> --repo <仓库名> [选项]
 *
 *   --repo 名字        必填（或用 --user-site 时必须是 <用户名>.github.io）
 *   --user-site        发布成用户站点 https://<用户名>.github.io/
 *   --private          建私有仓库（注意：免费账号的私有仓库 Pages 不构建）
 *   --reuse            仓库已存在时覆盖推送
 *   --desc 描述        仓库描述
 *   --forbidden a,b    上线后要复核是否已消失的原值（逗号分隔）
 *   --report 路径      脱敏报告，成功后把链接追加进去
 *
 * 前置条件：git 与 GitHub CLI（gh）可用且已 gh auth login。
 */

const path = require('path');
const deployLib = require('../lib/deploy');

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

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const dir = args._[0];

  if (!dir || !args.repo) {
    console.error('用法：node scripts/deploy.cjs <目录> --repo <仓库名> [--user-site] [--private] [--reuse]');
    console.error('      [--desc 描述] [--forbidden a,b] [--report 报告路径]');
    process.exit(2);
  }

  const forbidden = args.forbidden
    ? String(args.forbidden).split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  console.log('开始上线：' + path.resolve(dir));
  console.log('  仓库：' + args.repo + (args['user-site'] ? '（用户站点）' : '（项目站点）'));
  console.log('  可见性：' + (args.private ? '私有' : '公开'));
  console.log('');

  const res = await deployLib.deploy({
    dir: path.resolve(dir),
    repoName: args.repo,
    description: args.desc || '个人作品展示网站',
    siteType: args['user-site'] ? 'user' : 'project',
    visibility: args.private ? 'private' : 'public',
    reuse: !!args.reuse,
    toolsDir: process.env.HOMEPAGE_TOOLS_DIR || null,
    forbiddenValues: forbidden,
    reportPath: args.report || null,
    onLog: (lvl, msg) => {
      const tag = { info: '·', ok: '✓', warn: '!', error: '✗', cmd: '$' }[lvl] || '·';
      console.log('  ' + tag + ' ' + msg);
    },
    onProgress: (p, label) => {
      if (process.stdout.isTTY) process.stdout.write('\r  ' + String(p == null ? '--' : p).padStart(3) + '% ' + String(label || '').padEnd(40));
    }
  });

  if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(60) + '\r');

  if (!res.ok) {
    console.error('\n上线失败：' + (res.error && res.error.message));
    if (res.error && res.error.tip) console.error('提示：' + res.error.tip);
    process.exit(1);
  }

  console.log('\n上线成功');
  console.log('  链接：' + res.url);
  console.log('  仓库：' + res.repoUrl);
  console.log('  Pages：' + (res.pages.status || '未知') + ' · HTTPS 强制：' + (res.pages.httpsEnforced ? '已开启' : '未确认'));
  console.log(
    '  线上复核：' +
      (res.verify.ok
        ? '通过（无残留敏感信息）'
        : 'HTTP ' + res.verify.httpStatus + (res.verify.leftover.length ? '，仍有 ' + res.verify.leftover.length + ' 项残留：' + res.verify.leftover.join('、') : ''))
  );
  process.exit(res.verify.ok ? 0 : 1);
})().catch((e) => {
  console.error('出错：' + (e && e.message ? e.message : e));
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
