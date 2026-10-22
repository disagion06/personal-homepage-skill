# personal-homepage · 个人主页开发 Skill

> 把你的 AI 变成一个**会做个人主页、并且知道发布前要脱敏**的开发搭档。
> 不需要任何 API key —— **你的 AI 自己就是那个大模型**，这个 skill 提供的是
> 经过实操验证的**方法论** + 一批**零依赖的确定性脚本**。

---

## 它解决什么问题

大多数"AI 帮我做个个人主页"的最后一步都会翻车，翻在三个地方：

| 翻车点 | 后果 | 这个 skill 怎么处理 |
| --- | --- | --- |
| 图片靠 JS 注入、文件名带中文 | 本地正常，发布后全裂 | 静态 `src` 硬约束 + 素材预检脚本 + 自检脚本会逐张核对文件是否存在 |
| 视频是 HEVC 编码 | 点开黑屏 | 手写 MP4 box 解析探测编码，直接给出 ffmpeg 转码命令 |
| 页面里带着真实手机号/邮箱/照片 GPS | 上线后被爬虫抓走 | 21 条规则扫描 + 逐项处理 + 上线后抓真实链接复核 |

所以它不是"又一个 AI 生成网页的 prompt"，而是把**做完之后怎么办**也管了。

---

## 安装

Skill 的通用安装方式就是「把仓库放进你的 skills 目录」。

### Claude Code / 支持 Agent Skills 的客户端

```bash
git clone https://github.com/disagion06/personal-homepage-skill.git \
  ~/.claude/skills/personal-homepage
```

Windows PowerShell：

```powershell
git clone https://github.com/disagion06/personal-homepage-skill.git `
  "$env:USERPROFILE\.claude\skills\personal-homepage"
```

### Claude.ai / 支持上传 skill 的网页版

把整个仓库打包成 zip 上传，或在 Skill 设置里指向这个仓库。
核心是 `SKILL.md`，其余目录作为随附资源。

### 其他 AI 客户端（Cursor / Codex / Gemini CLI / 本地模型等）

没有标准 skills 目录的客户端，直接把 `SKILL.md` 的内容贴进系统提示或项目规则文件
（如 `AGENTS.md` / `.cursorrules`），并把 `scripts/` 与 `lib/` 放在同一工作目录下。
脚本只用 Node 内建模块，任何能跑 Node 的地方都能用。

### 依赖

- **Node 18+**（脚本用内建 `fetch`）
- 可选：`git` + GitHub CLI（`gh`）—— 只有最后一步"上线"需要
- 可选：`ffmpeg` —— 只有视频转码需要
- 可选：`electron` —— 只有真实渲染截图需要（静态自检不需要）

```bash
node --version   # 确认 ≥ 18
```

---

## 怎么用

装好之后，正常说话就行：

```
帮我做个个人主页，我是做后端的，三年经验，不用放照片，风格别太花
```

AI 会按 `SKILL.md` 的流程走：先问清用途/内容/风格 → 素材预检 → 给它确认区块结构 →
分块生成 → 六维评审并改 → 加动效 → 静态自检 → 脱敏 → 上线。

也可以直接调用脚本：

```bash
# 素材预检（只出计划，不改文件）
node scripts/preflight.cjs "D:/我的素材"

# 静态自检
node scripts/check-page.cjs "D:/我的主页"

# 扫描敏感信息
node scripts/redact.cjs scan "D:/我的主页"

# 脱敏生成上线目录
node scripts/redact.cjs build "D:/我的主页" --policy mask-high

# 本地预览
node scripts/preview.cjs "生成目录"

# 上线 GitHub Pages
node scripts/deploy.cjs "生成目录" --repo my-portfolio \
  --forbidden "13800138000,demo@example.com"
```

---

## 目录结构

```
├── SKILL.md                     ← 核心：AI 读的就是这个
├── references/                  ← 需要细节时再读（渐进披露）
│   ├── 01-流程与阶段.md            真实手工实操全记录
│   ├── 02-硬约束与踩坑.md          R1–R7 与九类高频坑
│   ├── 03-设计评审rubric.md        六维度打分标准
│   ├── 04-动效菜单.md              10 项动效菜单与实现要点
│   ├── 05-隐私脱敏规则.md          21 条规则与判断标准
│   ├── 06-上线流程.md              Pages 流程与网络降级方案
│   └── 07-常见问题.md              用户提问时先查这里
├── scripts/                     ← 确定性工具，零第三方依赖
│   ├── preflight.cjs               素材预检
│   ├── check-page.cjs              静态自检（可选截图）
│   ├── redact.cjs                  扫描 / 脱敏
│   ├── deploy.cjs                  上线 GitHub Pages
│   ├── preview.cjs                 本地预览
│   └── screenshot.cjs              Electron 渲染截图入口
├── assets/
│   ├── style-presets.json          8 套风格预设（含色板）
│   ├── rule.md.tpl                 建站规则模板
│   └── log.md.tpl                  进度日志模板
├── lib/                         ← 脚本依赖的零依赖实现
└── demos/minimal-portfolio/     ← 一个完整示例：输入 → 产出 → 评审记录
```

---

## 两个设计决定

**1. 不用外部模型 API。**
很多同类 skill 会去调 OpenAI/DeepSeek 的接口。这里不这么做——宿主 AI 本身就是模型，
再套一层 API 既浪费又需要用户配 key。所以 `lib/` 里没有任何 `fetch` 模型的代码，
只有确定性的文本/图片/文件处理。

**2. 脚本只做确定性的事，判断全部留给 AI。**
脚本不会替你决定"这个手机号该不该隐藏"，它只负责**准确地把命中的东西列出来**。
判断需要理解用户意图（求职页面的联系方式是故意公开的），那是模型该做的。

---

## 已验证

以下都是在真实素材与真实站点上跑过的，不是"应该能work"：

- 素材预检：从 16 个真实文件里正确识别出 2 个 HEVC 视频（`hvc1`）、1 个 PSD、1 个 AEP、
  12 个需要改名的中文文件名 —— 与人工判断一致
- 脱敏：合成测试站上 7 项命中全部正确定位到 `文件:行`，打码后自检 0 残留
- 静态自检：在生成的页面里抓到过"缺 `<h1>`"这个真实缺陷
- 上线：真实推送到 GitHub Pages 并抓回线上页面复核

---

## 许可

MIT
