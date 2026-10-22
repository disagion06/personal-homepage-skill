'use strict';
/**
 * 网页生成编排层。
 *
 * 把「一句话需求 + 素材」变成可上线的 index.html，流程照搬手工实操的九阶段：
 *   阶段 0 初始化（写 rule.md / log.md）
 *   阶段 1-2 取材与素材规整（交给 lib/assets.js）
 *   阶段 3 结构规划 → 分区块生成 → 确定性组装
 *   阶段 4 风格定向（调色板来自规划阶段）
 *   阶段 5 设计评审（打分 → 改动清单）
 *   阶段 7 截图自检（交给 lib/selfcheck.js，在 Electron 里跑）
 *
 * 设计要点：
 *  - **AI 只产出「区块片段」**，骨架、样式、组装全部是确定性代码，生成的不确定性被隔离在片段级；
 *  - 单块失败可单独重试，不会整页重生成；
 *  - 素材引用会被规范化成 assets/ 下的 ASCII 文件名（C1、C5）；
 *  - 生成产物是标准 index.html + assets/ 目录，可以直接喂给现有的扫描 / 脱敏 / 上线链路。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const llm = require('./llm');
const assets = require('./assets');
const util = require('./util');

/* ------------------------------------------------------------ 风格库 */

/**
 * 风格定向预设：照抄手工实操里「给一批参考，让模型挑一个并说明理由」的做法。
 * 每个预设给出具体的色板与视觉约束，避免模型自由发挥导致前后不一致。
 */
const STYLE_PRESETS = {
  plain: {
    label: '简洁现代',
    palette: { bg: '#ffffff', ink: '#111827', accent: '#2563eb', muted: '#6b7280' },
    rules: ['大量留白', '无衬线字体', '克制的强调色', '卡片式布局']
  },
  newspaper: {
    label: '报纸印刷（法兰西特派风）',
    palette: { bg: '#F2EDE1', ink: '#1F2A44', accent: '#C62828', muted: '#6b6152' },
    rules: [
      '对称构图，居中报头',
      '衬线字体 + 斜体英文眉标',
      '章节编号（01–05）',
      '细线分隔与方框，不用圆角',
      '纸色底 + 轻微噪点颗粒'
    ]
  },
  pastel: {
    label: '粉彩对称（布达佩斯大饭店风）',
    palette: { bg: '#F7D9DC', ink: '#5B3A4A', accent: '#9DD3C8', muted: '#8A6A78' },
    rules: ['强对称', '粉彩撞色', '几何装饰', '圆角边框']
  },
  dark: {
    label: '深色科技',
    palette: { bg: '#0B0F14', ink: '#E6EDF3', accent: '#22D3EE', muted: '#8B949E' },
    rules: ['深色底', '高对比强调色', '细边框卡片', '等宽字体点缀']
  }
};

const DEFAULT_STYLE = 'newspaper';

/* ------------------------------------------------------------ 提示词 */

function styleBlock(styleId) {
  const s = STYLE_PRESETS[styleId] || STYLE_PRESETS[DEFAULT_STYLE];
  return [
    '视觉风格：' + s.label,
    '色板：' + Object.entries(s.palette).map(([k, v]) => k + '=' + v).join('，'),
    '风格铁律：',
    ...s.rules.map((r) => '  - ' + r)
  ].join('\n');
}

function buildPlanPrompt(brief, styleId, assetList) {
  const style = styleBlock(styleId);
  const assetLines = assetList.length
    ? assetList.map((a) => '  - ' + a.to + '（' + a.kind + '，' + a.sizeText + '）').join('\n')
    : '  （没有素材，做成纯文字版式）';

  return [
    {
      role: 'system',
      content:
        '你是一名资深网页设计师。你的任务是**只做结构规划**，不写 HTML。\n' +
        '严格返回一个 JSON 对象，不要任何解释文字，不要 Markdown 代码围栏。'
    },
    {
      role: 'user',
      content: [
        '根据下面的需求，规划一个单页网站的区块结构。',
        '',
        '需求：',
        brief,
        '',
        style,
        '',
        '可用素材：',
        assetLines,
        '',
        '返回 JSON，字段：',
        '{',
        '  "title": "页面标题",',
        '  "palette": { "bg": "#xxx", "ink": "#xxx", "accent": "#xxx", "muted": "#xxx" },',
        '  "sections": [ { "id": "英文小写短横线 id", "purpose": "这一块要放什么内容", "assets": ["用到的素材文件名"] } ]',
        '}',
        '',
        '要求：',
        '- sections 控制在 3–6 个，顺序就是页面从上到下的顺序',
        '- 必须包含一个 hero（首屏）和一个 contact（联系方式）',
        '- 只使用上面列出的素材文件名，不要编造',
        '- 中文正文，英文小写 id'
      ].join('\n')
    }
  ];
}

function buildBlockPrompt(plan, section, styleId, assetList) {
  const style = styleBlock(styleId);
  const palette = plan.palette || (STYLE_PRESETS[styleId] || STYLE_PRESETS[DEFAULT_STYLE]).palette;
  const usable = assetList.filter(
    (a) => !section.assets || section.assets.length === 0 || section.assets.includes(a.to)
  );

  return [
    {
      role: 'system',
      content:
        '你是一名资深前端工程师。你只输出**一个区块的 HTML 片段**。\n' +
        '禁止输出 <html>/<head>/<body>/<style> 标签，禁止 Markdown 代码围栏，禁止任何解释文字。\n' +
        'CSS 类名统一用 "sec-' + section.id + '" 作为前缀，避免区块之间样式打架。'
    },
    {
      role: 'user',
      content: [
        '为下面这个区块写 HTML 片段。',
        '',
        '整站标题：' + (plan.title || '作品集'),
        '区块 id：' + section.id,
        '区块用途：' + section.purpose || '',
        '',
        style,
        '实际使用色板：' + Object.entries(palette).map(([k, v]) => k + '=' + v).join('，'),
        '',
        '可引用素材（写成 <img src="assets/文件名">，路径必须完全一致，不要加前缀）：',
        usable.length ? usable.map((a) => '  - assets/' + a.to).join('\n') : '  （本区块不使用素材）',
        '',
        '硬约束：',
        '- 语义化标签：<section>/<h2>/<p>/<ul> 等，不要一堆 <div>',
        '- 整页只能有一个 <h1>：如果这是首屏 hero 区块就用 <h1>，其余区块一律用 <h2>',
        '- 图片必须写静态 src，**不要用 JS 注入图片路径**',
        '- 图片必须有 alt',
        '- 不要引用任何外部资源（CDN 字体、外链图片都不行），只允许内联样式与本地 assets',
        '- 不要写 <script>',
        '- 中文文案，不要占位符式的"Lorem ipsum"'
      ].join('\n')
    }
  ];
}

function buildReviewPrompt(htmlExcerpt, plan, styleId) {
  return [
    {
      role: 'system',
      content:
        '你是一名严格的设计评审。只返回 JSON，不要任何解释文字，不要 Markdown 代码围栏。'
    },
    {
      role: 'user',
      content: [
        '按 6 个维度给下面的页面打分（0–10 分，可以用小数），并列出必须修的问题。',
        '',
        '维度：',
        '  概念：母题是否与内容强绑定、可不可替换',
        '  哲学一致性：所有细节是否服从同一套视觉语言',
        '  视觉层级：对比是否够（标题与正文的层级差）',
        '  细节执行：间距是否走网格、小字号是否可见、装饰是否散',
        '  功能性：有无冗余内容、入口是否过多',
        '  创新性：有无 AI 惯性装饰',
        '',
        styleBlock(styleId),
        '',
        '页面规划：' + JSON.stringify(plan.sections ? plan.sections.map((s) => s.id) : []),
        '',
        '页面 HTML（截断）：',
        String(htmlExcerpt).slice(0, 12000),
        '',
        '返回 JSON：',
        '{',
        '  "scores": { "概念": 8, "哲学一致性": 7, "视觉层级": 7, "细节执行": 6, "功能性": 7, "创新性": 7 },',
        '  "issues": [ { "dimension": "细节执行", "problem": "具体问题", "fix": "具体改法" } ],',
        '  "verdict": "一句话总结"',
        '}',
        '',
        'issues 必须具体到能直接改代码，例如「间距未走 8pt 网格」而不是「排版需优化」。最多 6 条。'
      ].join('\n')
    }
  ];
}

/* ------------------------------------------------------------ 解析工具 */

/** 宽容解析 JSON：去掉 Markdown 围栏、抓第一个完整 JSON 对象 */
function parseJsonLoose(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    /* 继续尝试 */
  }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/** 去掉模型爱加的 Markdown 代码围栏 */
function stripFences(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:html|HTML)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  return s;
}

/** 校验区块片段：去掉不该出现的东西，返回一段干净的 section */
function sanitizeBlock(html, sectionId) {
  let s = stripFences(html);
  // 模型偶尔会吐整个文档，取 body 内容
  const bodyMatch = s.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) s = bodyMatch[1].trim();
  // 去掉 head/文档级标签
  s = s.replace(/<!DOCTYPE[^>]*>/gi, '').replace(/<\/?(html|head|body|style)[^>]*>/gi, '');
  // 去掉 script（生成的页面保持纯静态；需要交互时另行处理）
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.trim();
  if (!s) return '';
  return s;
}

/**
 * 把区块里的图片引用规范化为 assets/ 下的真实文件名。
 * 模型经常写成 "assets/工 作照.jpg" 或者直接 "工 作照.jpg"，这里统一纠正。
 */
function normalizeAssetRefs(html, assetList) {
  if (!assetList || !assetList.length) return html;
  const byBasename = new Map();
  for (const a of assetList) {
    byBasename.set(a.to.toLowerCase(), a.to);
    // 原名也可能被模型引用
    if (a.original) byBasename.set(String(a.original).toLowerCase(), a.to);
  }

  return html.replace(/(\ssrc\s*=\s*)(["'])([^"']+)\2/gi, (whole, prefix, quote, url) => {
    if (/^(https?:|data:|mailto:|#)/i.test(url)) return whole;
    const clean = url.replace(/^\.?\//, '').replace(/^assets\//i, '');
    let decoded = clean;
    try {
      decoded = decodeURIComponent(clean);
    } catch {
      /* 保留原样 */
    }
    const hit = byBasename.get(decoded.toLowerCase());
    if (hit) return prefix + quote + 'assets/' + hit + quote;
    return whole;
  });
}

/* ------------------------------------------------------------ 确定性组装 */

/** 生成样式骨架：只用规划阶段给出的色板 + 一个响应式网格 + reduced-motion 兜底 */
function buildStyles(plan, styleId, animations) {
  const preset = STYLE_PRESETS[styleId] || STYLE_PRESETS[DEFAULT_STYLE];
  const p = plan.palette || preset.palette;
  const bg = p.bg || preset.palette.bg;
  const ink = p.ink || preset.palette.ink;
  const accent = p.accent || preset.palette.accent;
  const muted = p.muted || preset.palette.muted;
  const serif = styleId === 'newspaper' || styleId === 'pastel';

  const anim = animations === 'none' ? '' : `
@keyframes dd-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
.dd-reveal { opacity: 0; }
.dd-reveal.dd-in { animation: dd-rise .6s cubic-bezier(.2,.7,.3,1) both; }
`;

  return `
:root {
  --dd-bg: ${bg};
  --dd-ink: ${ink};
  --dd-accent: ${accent};
  --dd-muted: ${muted};
  --dd-gap: 8px;
  --dd-max: 1080px;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--dd-bg);
  color: var(--dd-ink);
  font-family: ${serif ? 'Georgia, "Songti SC", "SimSun", serif' : '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'};
  line-height: 1.7;
  font-size: 16px;
}
img { max-width: 100%; height: auto; display: block; }
a { color: var(--dd-accent); }
.dd-main { max-width: var(--dd-max); margin: 0 auto; padding: calc(var(--dd-gap) * 6) calc(var(--dd-gap) * 3); }
.dd-main > section { padding: calc(var(--dd-gap) * 6) 0; border-top: 1px solid color-mix(in srgb, var(--dd-ink) 18%, transparent); }
.dd-main > section:first-child { border-top: 0; padding-top: 0; }
.dd-main h1, .dd-main h2, .dd-main h3 { line-height: 1.25; margin: 0 0 calc(var(--dd-gap) * 2); }
.dd-main h1 { font-size: clamp(28px, 5vw, 52px); letter-spacing: -0.02em; }
.dd-main h2 { font-size: clamp(20px, 3vw, 30px); }
.dd-main p { margin: 0 0 calc(var(--dd-gap) * 2); color: var(--dd-ink); }
.dd-main ul { margin: 0 0 calc(var(--dd-gap) * 2); padding-left: 1.2em; }
.dd-main .dd-kicker { color: var(--dd-muted); text-transform: uppercase; letter-spacing: .18em; font-size: 12px; }
.dd-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
${anim}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
  .dd-reveal { opacity: 1 !important; }
}
`.trim();
}

/** 汇总规划 + 各区块片段 → 完整 index.html（这一步不调模型，完全确定性） */
function assemblePage({ plan, blocks, styleId, animations, assetList }) {
  const title = (plan.title || '我的作品集').replace(/[<>]/g, '');
  const palette = plan.palette || (STYLE_PRESETS[styleId] || STYLE_PRESETS[DEFAULT_STYLE]).palette;
  const css = buildStyles(plan, styleId, animations);

  const body = blocks
    .map((b) => normalizeAssetRefs(b.html || '', assetList))
    .filter(Boolean)
    .join('\n\n');

  // 安全网：整页必须有 h1（无障碍与 SEO 的硬要求）。
  // 模型经常整页只用 h2，所以这里兜一层视觉隐藏的 h1，不影响版式。
  const hasH1 = /<h1[\s>]/i.test(body);
  const hiddenH1 = hasH1 ? '' : '<h1 class="dd-sr-only">' + title + '</h1>\n';

  const script =
    animations === 'none'
      ? ''
      : `
(function () {
  var els = document.querySelectorAll('section');
  if (!('IntersectionObserver' in window)) {
    els.forEach(function (el) { el.classList.add('dd-in'); });
    return;
  }
  els.forEach(function (el) { el.classList.add('dd-reveal'); });
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) {
        en.target.classList.add('dd-in');
        io.unobserve(en.target);
      }
    });
  }, { rootMargin: '0px 0px -10% 0px' });
  els.forEach(function (el) { io.observe(el); });
})();
`.trim();

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${title}</title>
<meta name="description" content="${title}">
<style>
${css}
</style>
</head>
<body>
<main class="dd-main">
${hiddenH1}${body}
</main>
${script ? '<script>\n' + script + '\n</script>' : ''}
</body>
</html>
`;
}

/* ------------------------------------------------------------ 项目文档（阶段 0） */

async function writeProjectDocs(outDir, info) {
  const rule = [
    '# 建站规则（rule.md）',
    '',
    '> 本项目由「设计稿上线助手」生成，规则随项目一起保存，便于复用与交接。',
    '',
    '## 硬约束',
    '- 单页 `index.html`，内联 CSS/JS，纯静态，双击可在浏览器打开',
    '- 不引入任何 npm 依赖、不使用 React 等框架',
    '- 不引用外部 CDN 资源，只使用本地 `assets/`',
    '- 素材文件名必须 ASCII（小写字母 / 数字 / 短横线）',
    '- 所有动效必须尊重 `prefers-reduced-motion`',
    '',
    '## 风格',
    '- 预设：' + info.styleId + '（' + (STYLE_PRESETS[info.styleId] || {}).label + '）',
    '- 色板：```' + JSON.stringify(info.palette || {}) + '```',
    '',
    '## 素材',
    info.assetCount + ' 个文件，合计 ' + util.humanBytes(info.assetBytes || 0) + '，全部位于 `assets/`。',
    '改名映射见 `assets/assets-manifest.json`。',
    ''
  ].join('\n');

  const log = [
    '# 开发进度（log.md）',
    '',
    '## 阶段 0 · 项目初始化',
    '- 需求：' + String(info.brief || '').replace(/\n+/g, ' ').slice(0, 300),
    '- 风格预设：' + info.styleId,
    '- 时间：' + util.nowIso(),
    '',
    '## 阶段 1 · 素材规整',
    '- 来源目录：' + (info.sourceRoot || '（无）'),
    '- 复制 ' + info.assetCount + ' 个文件到 `assets/`，合计 ' + util.humanBytes(info.assetBytes || 0),
    '',
    '## 阶段 2 · 结构规划与生成',
    '- 区块：' + (info.sectionIds || []).join(' / '),
    '- 模型：' + (info.model || ''),
    '',
    '## 阶段 3 · 自检',
    '- 由 `lib/selfcheck.js` 生成桌面与移动端截图并检查（详见自检报告）',
    ''
  ].join('\n');

  await fsp.writeFile(path.join(outDir, 'rule.md'), rule, 'utf8');
  await fsp.writeFile(path.join(outDir, 'log.md'), log, 'utf8');
}

/* ------------------------------------------------------------ 主流程 */

/**
 * 从「一句话需求 + 素材目录」生成一个可上线的站点目录。
 *
 * @param {object} options
 * @param {string} options.brief 需求描述
 * @param {string} [options.sourceDir] 素材来源目录（可空）
 * @param {string} options.outDir 输出目录
 * @param {string} [options.style='newspaper'] 风格预设 id
 * @param {boolean} [options.withAssets=true] 是否复制素材
 * @param {'none'|'level1'} [options.animations='level1']
 * @param {string} [options.provider]
 * @param {string} [options.model]
 * @param {boolean} [options.review=false] 是否跑设计评审
 * @param {(ev:{phase:string,message:string,pct:number})=>void} [options.onProgress]
 */
async function generateSite(options = {}) {
  const brief = String(options.brief || '').trim();
  if (!brief) throw new Error('generateSite 需要 brief（需求描述）');

  const outDir = path.resolve(options.outDir || path.join(process.cwd(), 'site-out'));
  const styleId = options.style || DEFAULT_STYLE;
  const animations = options.animations || 'level1';
  const withAssets = options.withAssets !== false;
  const emit = (phase, message, pct) => {
    if (typeof options.onProgress === 'function') {
      try {
        options.onProgress({ phase, message, pct });
      } catch {
        /* 界面回调出错不影响生成 */
      }
    }
  };

  const llmOpts = { provider: options.provider, model: options.model };
  const usageTotal = { promptTokens: 0, completionTokens: 0, costUsd: 0, calls: 0 };

  /* ---- 阶段 1：素材规整 ---- */
  emit('assets', '整理素材…', 5);
  let assetList = [];
  let manifest = null;
  let plan = null;

  if (withAssets && options.sourceDir) {
    const scan = await assets.scanSources(options.sourceDir);
    plan = assets.planAssets(scan, { outName: 'assets' });
    if (plan.copyList.length) {
      await util.ensureDir(outDir);
      manifest = await assets.applyPlan(plan, { outDir: path.join(outDir, 'assets') });
      assetList = plan.copyList.map((c) => ({
        to: c.to,
        kind: c.kind,
        bytes: c.size,
        sizeText: util.humanBytes(c.size),
        original: c.rel.split('/').pop()
      }));
    }
  } else {
    await util.ensureDir(outDir);
  }

  /* ---- 阶段 3-1：结构规划 ---- */
  emit('plan', '规划页面结构…', 20);
  let sitePlan = null;
  try {
    const r = await llm.generate({
      ...llmOpts,
      messages: buildPlanPrompt(brief, styleId, assetList),
      mockKind: 'structure',
      jsonMode: true
    });
    accumulate(usageTotal, r);
    sitePlan = parseJsonLoose(r.text);
  } catch (e) {
    emit('plan', '结构规划失败，改用默认结构：' + e.message, 20);
  }

  if (!sitePlan || !Array.isArray(sitePlan.sections) || !sitePlan.sections.length) {
    // 兜底结构：保证即使模型抽风也能产出完整页面
    sitePlan = {
      title: '我的作品集',
      palette: (STYLE_PRESETS[styleId] || STYLE_PRESETS[DEFAULT_STYLE]).palette,
      sections: [
        { id: 'hero', purpose: '姓名与一句话定位' },
        { id: 'about', purpose: '基本信息与经历' },
        { id: 'works', purpose: '作品列表' },
        { id: 'contact', purpose: '联系方式' }
      ]
    };
  }
  if (!sitePlan.palette) sitePlan.palette = (STYLE_PRESETS[styleId] || STYLE_PRESETS[DEFAULT_STYLE]).palette;

  /* ---- 阶段 3-2：分区块生成 ---- */
  const blocks = [];
  const total = sitePlan.sections.length;
  for (let i = 0; i < total; i++) {
    const sec = sitePlan.sections[i];
    const id = String(sec.id || 'section-' + (i + 1)).replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'section-' + (i + 1);
    const pct = 25 + Math.round((i / total) * 45);
    emit('blocks', '生成区块 ' + (i + 1) + '/' + total + '：' + id, pct);
    try {
      const r = await llm.generate({
        ...llmOpts,
        messages: buildBlockPrompt(sitePlan, { ...sec, id }, styleId, assetList),
        mockKind: 'block'
      });
      accumulate(usageTotal, r);
      const html = sanitizeBlock(r.text, id);
      blocks.push({ id, html: html ? '<section id="' + id + '">\n' + html + '\n</section>' : '' });
    } catch (e) {
      blocks.push({
        id,
        html: '<section id="' + id + '"><h2>' + id + '</h2><p>（这一块生成失败：' + util.escapeHtml(e.message) + '）</p></section>'
      });
    }
  }

  /* ---- 阶段 3-3：确定性组装 ---- */
  emit('assemble', '组装页面…', 72);
  const html = assemblePage({ plan: sitePlan, blocks, styleId, animations, assetList });
  await fsp.writeFile(path.join(outDir, 'index.html'), html, 'utf8');

  /* ---- 阶段 0：项目文档 ---- */
  await writeProjectDocs(outDir, {
    brief,
    styleId,
    palette: sitePlan.palette,
    sourceRoot: options.sourceDir || '',
    assetCount: assetList.length,
    assetBytes: assetList.reduce((s, a) => s + (a.bytes || 0), 0),
    sectionIds: blocks.map((b) => b.id),
    model: options.model || (llmOpts.provider || 'default')
  });

  /* ---- 阶段 5：设计评审（可选） ---- */
  let review = null;
  if (options.review) {
    emit('review', '设计评审…', 85);
    try {
      const r = await llm.generate({
        ...llmOpts,
        messages: buildReviewPrompt(html, sitePlan, styleId),
        mockKind: 'review',
        jsonMode: true
      });
      accumulate(usageTotal, r);
      review = parseJsonLoose(r.text);
    } catch (e) {
      review = { error: e.message };
    }
  }

  emit('done', '生成完成', 100);

  return {
    ok: true,
    outDir,
    entry: path.join(outDir, 'index.html'),
    style: styleId,
    animations,
    plan: sitePlan,
    blocks: blocks.map((b) => ({ id: b.id, bytes: Buffer.byteLength(b.html || '', 'utf8') })),
    assets: { count: assetList.length, manifest: manifest ? path.join(outDir, 'assets', 'assets-manifest.json') : null },
    review,
    usage: usageTotal
  };
}

function accumulate(total, res) {
  total.calls++;
  if (res && res.usage) {
    total.promptTokens += res.usage.promptTokens || 0;
    total.completionTokens += res.usage.completionTokens || 0;
  }
  total.costUsd += (res && res.costUsd) || 0;
}

module.exports = {
  STYLE_PRESETS,
  DEFAULT_STYLE,
  parseJsonLoose,
  stripFences,
  sanitizeBlock,
  normalizeAssetRefs,
  assemblePage,
  buildStyles,
  generateSite,
  writeProjectDocs,
  buildPlanPrompt,
  buildBlockPrompt,
  buildReviewPrompt
};
