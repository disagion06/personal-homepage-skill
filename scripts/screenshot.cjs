'use strict';
/**
 * 真实渲染截图与运行时检查（可选，需要 Electron）。
 * 由 scripts/check-page.cjs --screenshot 自动调用，一般不直接跑。
 *
 *   npx electron scripts/screenshot.cjs <站点目录> --out <截图与报告目录>
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const selfcheck = require('../lib/selfcheck');

const args = process.argv.slice(2);
const positional = [];
let outDir = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outDir = args[++i];
  else if (!args[i].startsWith('--')) positional.push(args[i]);
}

const dir = positional[0];
if (!dir) {
  console.error('用法：electron scripts/screenshot.cjs <站点目录> [--out 目录]');
  app.exit(2);
}

app.whenReady().then(async () => {
  try {
    const shotsDir = path.resolve(outDir || path.join(dir, '.selfcheck'));
    const report = await selfcheck.checkSite({ dir: path.resolve(dir), shotsDir });
    fs.mkdirSync(shotsDir, { recursive: true });
    fs.writeFileSync(path.join(shotsDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(selfcheck.formatReport(report));
    app.exit(report.ok ? 0 : 1);
  } catch (e) {
    console.error('截图自检失败：' + (e && e.message ? e.message : e));
    app.exit(3);
  }
});
