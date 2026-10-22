#!/usr/bin/env node
'use strict';
/**
 * 命令行入口（GUI 之外的备用方式，也方便自动化 / 答辩演示）。
 *
 * 用法：
 *   node bin/dd-cli.cjs scan  <站点目录> [--json 扫描结果.json] [--keywords 关键词1,关键词2]
 *   node bin/dd-cli.cjs build <站点目录> [--decisions 决定.json | --policy mask-all|mask-high|hide-all|keep-all]
 *                                      [--exclude a,b] [--interactive] [--out 工作区]
 *                                      [--keep-exif] [--notice] [--title 新标题]
 *   node bin/dd-cli.cjs deploy <生成目录> --repo 仓库名 [--user-site] [--reuse] [--private]
 *                                        [--desc 描述] [--report 报告.md]
 *   node bin/dd-cli.cjs all <站点目录> --policy mask-all [--exclude _backup,_shots] [--repo 仓库名] [--deploy]
 *   node bin/dd-cli.cjs tools [--setup] [--login]
 *
 * 决定 JSON 格式：{ "decisions": { "v:0": "mask" }, "imageDecisions": { "img:assets/a.jpg": "mask" }, "exclude": [] }
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const scanner = require('../lib/scanner');
const redactor = require('../lib/redactor');
const deployLib = require('../lib/deploy');
const toolLib = require('../lib/tools');
const generateLib = require('../lib/generate');
const assetsLib = require('../lib/assets');
const { humanBytes, slugify, timestampTag } = require('../lib/util');
const { spawnSync } = require('child_process');

/* ------------------------------------------------------------ 参数解析 */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  bold: '\x1b[1m'
};
const color = (c, s) => (process.stdout.isTTY ? c + s + C.reset : s);
const log = (level, msg) => {
  const tag = { info: color(C.blue, '·'), ok: color(C.green, '✓'), warn: color(C.yellow, '!'), error: color(C.red, '✗'), cmd: color(C.dim, '$') }[level] || '·';
  console.log('  ' + tag + ' ' + msg);
};

/** 工具目录：可用环境变量 DD_TOOLS_DIR 覆盖（Electron 版用的是 userData/tools） */
const TOOLS_DIR = process.env.DD_TOOLS_DIR || path.join(os.homedir(), '.design-deployer-tools');

/* ------------------------------------------------------------ 策略 */

function applyPolicy(scanResult, policy) {
  const decisions = {};
  const imageDecisions = {};
  for (const f of scanResult.findings) {
    if (policy === 'keep-all') decisions[f.id] = 'keep';
    else if (policy === 'mask-high') decisions[f.id] = f.severity === 'high' ? 'mask' : 'keep';
    else if (policy === 'hide-all') decisions[f.id] = 'hideblock';
    else decisions[f.id] = f.severity === 'low' ? 'keep' : 'mask';
  }
  for (const im of scanResult.images) {
    if (policy === 'keep-all') imageDecisions[im.id] = 'keep';
    else imageDecisions[im.id] = im.isPortrait ? 'mask' : 'keep';
  }
  return { decisions, imageDecisions };
}

async function askDecisions(scanResult) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const q = (s) => new Promise((resolve) => rl.question(s, resolve));
  const decisions = {};
  const imageDecisions = {};
  console.log(color(C.bold, '\n逐项确认敏感信息（回车 = 采用建议值）'));
  console.log(color(C.dim, '  可选：m 打码 / d 删除 / h 隐藏整块 / k 保留\n'));
  for (const f of scanResult.findings) {
    const sug = f.defaultAction === 'keep' ? 'k' : 'm';
    const ans = (
      await q(
        '  [' + f.severity + '] ' + f.ruleLabel + '：' + f.value + '  ×' + f.count + ' → ' + (f.maskPreview || '') + '  (m/d/h/k) [' + sug + '] '
      )
    ).trim().toLowerCase();
    const v = ans || sug;
    decisions[f.id] = { m: 'mask', d: 'delete', h: 'hideblock', k: 'keep' }[v] || 'mask';
  }
  for (const im of scanResult.images) {
    const sug = im.defaultAction === 'keep' ? 'k' : 'm';
    const ans = (await q('  图片 ' + im.rel + ' [' + im.tags.join(',') + '] (m 模糊/d 删除/k 保留) [' + sug + '] ')).trim().toLowerCase();
    const v = ans || sug;
    imageDecisions[im.id] = { m: 'mask', d: 'delete', k: 'keep' }[v] || 'keep';
  }
  rl.close();
  return { decisions, imageDecisions };
}

/* ------------------------------------------------------------ 子命令 */

async function cmdScan(args) {
  const root = args._[1];
  if (!root) throw new Error('用法：dd-cli scan <站点目录>');
  const res = await scanner.scan({ root, customKeywords: (args.keywords || '').split(',').filter(Boolean), onLog: log });
  if (!res.ok) throw new Error(res.error && res.error.message);

  console.log(color(C.bold, '\n站点：') + res.name + '  入口：' + res.indexHtml + '  文件：' + res.stats.files + '（' + humanBytes(res.stats.bytes) + '）');
  console.log(color(C.bold, '\n文本敏感信息 ' + res.findings.length + ' 项'));
  for (const f of res.findings) {
    const sev = f.severity === 'high' ? color(C.red, '高') : f.severity === 'medium' ? color(C.yellow, '中') : color(C.dim, '低');
    console.log('  ' + sev + ' ' + f.ruleLabel.padEnd(12) + ' ' + f.value.slice(0, 28).padEnd(30) + ' ×' + String(f.count).padEnd(3) + ' → ' + (f.maskPreview || '-') + ' ' + color(C.dim, f.id));
  }
  console.log(color(C.bold, '\n图片 ' + res.images.length + ' 张（人像 / 含位置信息的排前面）'));
  for (const im of res.images.slice(0, 15)) {
    console.log('  ' + (im.isPortrait ? color(C.red, '人像') : '    ') + ' ' + im.rel.padEnd(36) + humanBytes(im.bytes).padStart(9) + '  ' + color(C.dim, im.tags.join(',')) + (im.gps ? color(C.red, ' GPS ' + im.gps.lat + ',' + im.gps.lng) : ''));
  }
  if (res.largeFiles.length) {
    console.log(color(C.bold, '\n大文件（建议排除）'));
    res.largeFiles.forEach((f) => console.log('  ' + f.rel + '  ' + humanBytes(f.bytes)));
  }
  if (res.suggestedExcludes.length) {
    console.log(color(C.bold, '\n建议排除'));
    res.suggestedExcludes.forEach((f) => console.log('  ' + f.rel + '  ' + humanBytes(f.bytes) + '  — ' + f.reason));
  }
  if (res.warnings.length) {
    console.log(color(C.bold, '\n提示'));
    res.warnings.forEach((w) => console.log('  ! ' + w));
  }
  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(res, null, 2), 'utf8');
    console.log('\n扫描结果已写入 ' + args.json);
  }
  return res;
}

async function buildWith(args, scanResult) {
  let decisionsPayload;
  if (args.decisions) {
    decisionsPayload = JSON.parse(fs.readFileSync(args.decisions, 'utf8'));
  } else if (args.interactive) {
    decisionsPayload = await askDecisions(scanResult);
  } else {
    decisionsPayload = applyPolicy(scanResult, args.policy || 'mask-all');
  }
  const exclude = args.exclude ? String(args.exclude).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const res = await redactor.build({
    root: args._.length > 1 ? args._[1] : scanResult.root,
    decisions: decisionsPayload.decisions || {},
    imageDecisions: decisionsPayload.imageDecisions || {},
    exclude,
    scanResult,
    options: {
      workDir: args.out || path.join(os.homedir(), 'design-deployer-workspaces'),
      toolsDir: TOOLS_DIR,
      stripExif: args['keep-exif'] !== true,
      addNotice: !!args.notice,
      siteTitle: args.title || null
    },
    onLog: log,
    onProgress: (p, label) => process.stdout.isTTY && process.stdout.write('\r  ' + String(p).padStart(3) + '% ' + label.padEnd(40)),
    overwrite: true
  });
  return res;
}

async function cmdBuild(args) {
  const root = args._[1];
  if (!root) throw new Error('用法：dd-cli build <站点目录> [--policy mask-all]');
  const scanResult = await scanner.scan({ root, onLog: log });
  if (!scanResult.ok) throw new Error(scanResult.error && scanResult.error.message);
  const res = await buildWith(args, scanResult);
  if (!res.ok) throw new Error(res.error && res.error.message);
  printBuildResult(res);
  return res;
}

function printBuildResult(res) {
  console.log('\n' + color(C.bold, '生成完成'));
  console.log('  上线目录：' + res.outDir);
  console.log('  文件：' + res.stats.files + ' 个 / ' + humanBytes(res.stats.bytes) + '，整块隐藏 ' + res.hiddenBlocks + ' 处');
  const zh = { mask: '打码', delete: '删除', hideblock: '隐藏整块', keep: '保留' };
  console.log(color(C.bold, '  已处理：'));
  for (const a of res.applied.filter((a) => a.action !== 'keep')) {
    console.log('    ' + (zh[a.action] || a.action).padEnd(6) + ' ' + a.ruleLabel.padEnd(12) + ' ' + a.value.slice(0, 26).padEnd(28) + ' ×' + a.count);
  }
  const kept = res.applied.filter((a) => a.action === 'keep');
  if (kept.length) {
    console.log(color(C.yellow, '  仍将公开：'));
    for (const a of kept) console.log('    保留   ' + a.ruleLabel.padEnd(12) + ' ' + a.value.slice(0, 26).padEnd(28) + ' ×' + a.count);
  }
  console.log('  脱敏报告：' + res.reportPath);
  if (res.leftover.length) console.log(color(C.red, '  ⚠ 自检未通过：' + res.leftover.map((l) => l.value).join('、')));
  if (res.warnings.length) res.warnings.forEach((w) => console.log('  ! ' + w));
}

async function cmdDeploy(args, built) {
  const dir = built ? built.outDir : args._[1];
  if (!dir) throw new Error('用法：dd-cli deploy <生成目录> --repo 仓库名');
  const repo = args.repo || slugify(path.basename(path.resolve(dir)));
  const forbidden = built ? built.applied.filter((a) => a.action !== 'keep').map((a) => a.value) : [];
  const res = await deployLib.deploy({
    dir,
    repoName: repo,
    description: args.desc || '个人作品展示网站',
    siteType: args['user-site'] ? 'user' : 'project',
    visibility: args.private ? 'private' : 'public',
    reuse: !!args.reuse,
    toolsDir: TOOLS_DIR,
    forbiddenValues: forbidden,
    reportPath: built ? built.reportPath : args.report || null,
    onLog: log,
    onProgress: (p, label) => process.stdout.isTTY && process.stdout.write('\r  ' + String(p).padStart(3) + '% ' + label.padEnd(50))
  });
  if (!res.ok) {
    console.log('\n' + color(C.red, '上线失败：') + res.error.message + (res.error.tip ? '\n  建议：' + res.error.tip : ''));
    process.exitCode = 1;
    return res;
  }
  console.log('\n' + color(C.green, color(C.bold, '🎉 网站已上线')) + '\n');
  console.log('  ' + color(C.bold, res.url));
  console.log('  仓库：' + res.repoUrl);
  console.log('  Pages：' + (res.pages.status || '未知') + ' · HTTPS 强制：' + (res.pages.httpsEnforced ? '已开启' : '未确认'));
  console.log('  线上复核：' + (res.verify.ok ? color(C.green, '通过（无残留敏感信息）') : color(C.yellow, 'HTTP ' + res.verify.httpStatus + (res.verify.leftover.length ? '，仍有 ' + res.verify.leftover.length + ' 项残留' : ''))));
  return res;
}

async function cmdAll(args) {
  const root = args._[1];
  if (!root) throw new Error('用法：dd-cli all <站点目录> --policy mask-all [--deploy --repo 名字]');
  const scanResult = await scanner.scan({ root, onLog: log });
  if (!scanResult.ok) throw new Error(scanResult.error && scanResult.error.message);
  const res = await buildWith(args, scanResult);
  if (!res.ok) throw new Error(res.error && res.error.message);
  printBuildResult(res);
  if (args.deploy) return cmdDeploy(args, res);
  console.log('\n' + color(C.dim, '（未加 --deploy，仅生成；确认无误后加 --deploy 上线）'));
  return res;
}

async function cmdTools(args) {
  const toolsDir = TOOLS_DIR;
  let st = await toolLib.status({ toolsDir });
  const show = (s) => {
    console.log(color(C.bold, '\n环境状态'));
    console.log('  Node      ' + (s.node.ok ? color(C.green, s.node.version) : color(C.red, '缺失')));
    console.log('  npm       ' + (s.npm.ok ? color(C.green, s.npm.version) : color(C.red, '缺失')));
    console.log('  Git       ' + (s.git.ok ? color(C.green, s.git.version) : color(C.red, '缺失')) + (s.git.path ? color(C.dim, '  ' + s.git.path) : ''));
    console.log('  GitHub CLI' + (s.gh.ok ? color(C.green, ' ' + s.gh.version + '（' + s.gh.source + '）') : color(C.red, ' 缺失')));
    console.log('  GitHub 登录' + (s.auth.loggedIn ? color(C.green, ' ' + s.auth.user) : color(C.yellow, ' 未登录')));
    console.log('  图片打码插件 ' + (s.sharp.ok ? color(C.green, 'sharp ' + s.sharp.version) : color(C.yellow, '未安装（将用占位图代替）')));
    console.log('  网络      ' + (s.net.ok ? color(C.green, '可访问 api.github.com') : color(C.red, '不可达')));
  };
  show(st);
  if (args.setup) {
    console.log('');
    const r = await toolLib.setup({ toolsDir, onLog: log, onProgress: () => {} });
    st = r.tools;
    show(st);
  }
  if (args.login) {
    const r = await toolLib.loginGithub({ toolsDir, onLog: log, onProgress: () => {} });
    if (!r.ok) console.log(color(C.red, '\n登录失败：') + r.error.message);
  }
  return st;
}

/* ------------------------------------------------------------ 网页制作 */

async function cmdMake(args) {
  const brief = args.brief || args._[2];
  if (!brief) {
    throw new Error(
      '用法：dd-cli make <输出目录> --brief "想做怎样的网页" [--src 素材目录]\n' +
        '           [--style newspaper|plain|pastel|dark] [--anim level1|none]\n' +
        '           [--review] [--provider deepseek] [--model 模型名]\n' +
        '           [--no-redact] [--policy mask-all] [--deploy --repo 仓库名]'
    );
  }

  const outDir = args._[1] || path.join(process.cwd(), '.work', 'make-' + timestampTag());

  console.log(color(C.bold, '\n[1/4] 生成网页'));
  console.log('  输出目录：' + outDir);
  console.log('  风格：' + (args.style || generateLib.DEFAULT_STYLE) + ' / 动效：' + (args.anim || 'level1'));

  const gen = await generateLib.generateSite({
    brief,
    sourceDir: args.src,
    outDir,
    style: args.style || generateLib.DEFAULT_STYLE,
    animations: args.anim || 'level1',
    review: !!args.review,
    provider: args.provider,
    model: args.model,
    withAssets: args['no-assets'] !== true,
    onProgress: (ev) => {
      if (process.stdout.isTTY) process.stdout.write('\r  ' + String(ev.pct).padStart(3) + '% ' + ev.message.padEnd(46));
    }
  });

  if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(60) + '\r');
  console.log('  区块：' + gen.blocks.map((b) => b.id).join(' / '));
  console.log('  素材：' + gen.assets.count + ' 个');
  console.log('  模型调用：' + gen.usage.calls + ' 次，tokens ' + gen.usage.promptTokens + '/' + gen.usage.completionTokens);
  if (gen.review && gen.review.scores) {
    console.log('  设计评审：' + Object.entries(gen.review.scores).map(([k, v]) => k + ' ' + v).join(' · '));
    for (const issue of (gen.review.issues || []).slice(0, 3)) {
      console.log('    [' + issue.dimension + '] ' + issue.problem + ' → ' + issue.fix);
    }
  }

  if (args['no-redact'] === true) {
    console.log('\n' + color(C.dim, '（加了 --no-redact，跳过脱敏；页面在 ' + outDir + '）'));
    return gen;
  }

  // 接着走既有的脱敏链路：扫描 → 生成上线目录
  console.log(color(C.bold, '\n[2/4] 扫描敏感信息'));
  const generatedSiteDir = gen.outDir;
  args._ = [args._[0], generatedSiteDir];
  // 脱敏产物默认放在生成目录旁边，避免写进用户主目录、也不覆盖刚生成的原稿
  if (!args.out) {
    args.out = path.join(path.dirname(generatedSiteDir), path.basename(generatedSiteDir) + '-redacted');
  }

  const scanResult = await scanner.scan({ root: generatedSiteDir, onLog: log });
  if (!scanResult.ok) throw new Error(scanResult.error && scanResult.error.message);
  console.log('  命中 ' + scanResult.findings.length + ' 项敏感信息，图片 ' + scanResult.images.length + ' 张');

  console.log(color(C.bold, '\n[3/4] 生成脱敏上线目录'));
  const built = await buildWith(args, scanResult);
  if (!built.ok) throw new Error(built.error && built.error.message);
  printBuildResult(built);

  if (args.deploy) {
    console.log(color(C.bold, '\n[4/4] 上线'));
    return cmdDeploy(args, built);
  }

  console.log('\n' + color(C.dim, '（未加 --deploy，仅生成脱敏目录；确认无误后加 --deploy 上线）'));
  return built;
}

/* ------------------------------------------------------------ 截图自检 */

async function cmdCheck(args) {
  const dir = args._[1];
  if (!dir) throw new Error('用法：dd-cli check <站点目录> [--json 报告.json] [--out 截图目录]');

  let electronPath = '';
  try {
    const e = require('electron');
    electronPath = typeof e === 'string' ? e : '';
  } catch {
    electronPath = '';
  }
  if (!electronPath) {
    throw new Error('截图自检需要 Electron（devDependency）：请先 npm install');
  }

  const script = path.join(__dirname, '..', 'scripts', 'selfcheck.cjs');
  const childArgs = [script, path.resolve(dir)];
  if (args.out) childArgs.push('--out', path.resolve(args.out));
  if (args.json) childArgs.push('--json', path.resolve(args.json));

  const r = spawnSync(electronPath, childArgs, { stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exitCode = r.status || 1;
  return r.status;
}

/* ------------------------------------------------------------ 素材预检 */

async function cmdAssets(args) {
  const dir = args._[1];
  if (!dir) throw new Error('用法：dd-cli assets <素材目录> [--apply 目标目录]');
  const scan = await assetsLib.scanSources(dir);
  console.log(assetsLib.formatScan(scan));
  const plan = assetsLib.planAssets(scan, { outName: args.name || 'assets' });
  console.log(assetsLib.formatPlan(plan));

  if (args.apply) {
    const target = path.resolve(args.apply);
    const manifest = await assetsLib.applyPlan(plan, { outDir: target });
    console.log(color(C.green, '\n已复制 ' + manifest.files.length + ' 个文件到 ' + target));
    console.log('  改名清单：' + path.join(target, 'assets-manifest.json'));
  } else {
    console.log(color(C.dim, '\n（只是预检，未复制任何文件。加 --apply 目标目录 才会执行）'));
  }
  return plan;
}

/* ------------------------------------------------------------ main */

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  try {
    switch (cmd) {
      case 'scan':
        await cmdScan(args);
        break;
      case 'build':
        await cmdBuild(args);
        break;
      case 'deploy':
        await cmdDeploy(args, null);
        break;
      case 'all':
        await cmdAll(args);
        break;
      case 'tools':
        await cmdTools(args);
        break;
      case 'make':
        await cmdMake(args);
        break;
      case 'check':
        await cmdCheck(args);
        break;
      case 'assets':
        await cmdAssets(args);
        break;
      default:
        console.log(`设计稿上线助手 · 命令行

  make   <输出目录> --brief "想做怎样的网页" [--src 素材目录]
                   [--style newspaper|plain|pastel|dark] [--anim level1|none]
                   [--review] [--provider deepseek] [--model 模型名]
                   [--no-redact] [--policy mask-all] [--deploy --repo 仓库名]
                                                    一句话生成网页 → 脱敏 → 上线（一条龙）
  assets <素材目录> [--apply 目标目录]                素材预检：命名 / 编码 / 源工程 / 重复图
  check  <站点目录> [--json 报告.json] [--out 截图目录]
                                                    截图自检（需 Electron）：JS 错误 / 裂图 / 溢出 / 重叠
  scan   <站点目录> [--json 文件] [--keywords 关键词1,关键词2]   只扫描并列出敏感信息
  build  <站点目录> [--policy mask-all|mask-high|hide-all|keep-all]
                    [--decisions 决定.json] [--interactive]
                    [--exclude _backup,_shots] [--out 工作区]
                    [--keep-exif] [--notice] [--title 新标题]
  deploy <生成目录> --repo 仓库名 [--user-site] [--private] [--reuse]
                    [--desc 描述] [--report 报告.md]
  all    <站点目录> --policy mask-all [--exclude ...] [--deploy --repo 名字] [--report 报告.md]
  tools  [--setup] [--login]                            检查 / 安装环境、登录 GitHub

  模型（make 用）：
    默认 mock，不需要任何 key 就能跑通全流程（返回确定性示例页面）
    真模型：设置环境变量 DEEPSEEK_API_KEY / ARK_API_KEY / DASHSCOPE_API_KEY 等
            再配 --provider deepseek --model deepseek-chat

  策略（--policy）语义：
    mask-all  高危/中危一律打码，低危保留（默认，最省事）
    mask-high 只打码高危，其余保留
    hide-all  全部「隐藏整块」（会删掉所在条目，页面可能出现空缺）
    keep-all  全部保留（只做图片元数据清理与生成，适合先看效果）

  环境变量：DD_TOOLS_DIR 覆盖插件目录（默认 ~/.design-deployer-tools）

示例：
  :: 网页制作一条龙（无需 API key）
  node bin/dd-cli.cjs make .work\\my-site --brief "个人作品集单页，含作品列表与联系方式"

  :: 带素材 + 真模型 + 直接上线
  node bin/dd-cli.cjs make .work\\my-site --brief "个人作品集" --src "D:\\素材" ^
      --provider deepseek --model deepseek-chat --style newspaper --review ^
      --policy mask-all --deploy --repo my-portfolio

  :: 原有链路
  node bin/dd-cli.cjs all "E:\\我的作品集" --policy mask-all --exclude _backup,_shots --deploy --repo my-portfolio
`);
    }
  } catch (e) {
    console.error('\n' + color(C.red, '出错：') + e.message);
    if (process.env.DD_DEBUG) console.error(e.stack);
    process.exitCode = 1;
  }
})();
