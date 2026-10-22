'use strict';
/**
 * 模型调用层（provider 抽象）。
 *
 * 设计原则：
 *  1. 零第三方依赖 —— 只用 Node 内建 fetch（Node 18+）。
 *  2. 业务代码只调 generate() / generateStream()，**永远不感知厂商差异**。
 *  3. 没有 API key 也能跑 —— 内置 mock 适配器返回确定性产物，用于跑通全流程与评测。
 *  4. key 只从环境变量或用户目录配置文件读取，**永不写入仓库、永不打印**。
 *
 * 新增一家厂商的做法：在 PRESETS 里加一条，或在配置里写 baseURL + model 即可。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* ------------------------------------------------------------ 错误类型 */

class LlmError extends Error {
  /**
   * @param {string} message
   * @param {{provider?:string, status?:number, retryable?:boolean, cause?:any}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'LlmError';
    this.provider = info.provider || '';
    this.status = info.status || 0;
    this.retryable = !!info.retryable;
    if (info.cause) this.cause = info.cause;
  }
}

/* ------------------------------------------------------------ 厂商预设 */

/**
 * 统一的 OpenAI 兼容格式覆盖了绝大多数国内厂商。
 * baseURL 末尾不要带 /chat/completions，适配器会自己拼。
 */
const PRESETS = {
  mock: { label: '本地模拟（无需 key）', kind: 'mock', needsKey: false },

  deepseek: {
    label: 'DeepSeek',
    kind: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    envKey: 'DEEPSEEK_API_KEY'
  },
  ark: {
    label: '火山方舟（豆包模型）',
    kind: 'openai',
    // 方舟的 model 要填「接入点 ID」或模型名，形如 doubao-1-5-pro-32k-250115
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-1-5-pro-32k-250115',
    envKey: 'ARK_API_KEY'
  },
  qwen: {
    label: '通义千问（DashScope 兼容模式）',
    kind: 'openai',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    envKey: 'DASHSCOPE_API_KEY'
  },
  moonshot: {
    label: 'Kimi / Moonshot',
    kind: 'openai',
    baseURL: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    envKey: 'MOONSHOT_API_KEY'
  },
  openai: {
    label: 'OpenAI',
    kind: 'openai',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY'
  },
  anthropic: {
    label: 'Anthropic Claude',
    kind: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
    envKey: 'ANTHROPIC_API_KEY'
  }
};

/**
 * 粗略价目表（美元 / 百万 token），**仅用于预算守卫和日志展示，不是账单依据**。
 * 单价会变，请按需在配置文件里覆盖 pricing。
 */
const PRICING = {
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'qwen-plus': { in: 0.4, out: 1.2 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'moonshot-v1-8k': { in: 1.68, out: 1.68 }
};

const DEFAULT_CONFIG_FILE = path.join(os.homedir(), '.design-deployer-llm.json');

/* ------------------------------------------------------------ 配置读取 */

function readConfigFile(file = process.env.DD_LLM_CONFIG || DEFAULT_CONFIG_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 取某预设的 key：环境变量 DD_LLM_API_KEY 优先，其次该厂商专属环境变量 */
function envKeyFor(preset) {
  if (process.env.DD_LLM_API_KEY) return process.env.DD_LLM_API_KEY;
  if (preset && preset.envKey && process.env[preset.envKey]) return process.env[preset.envKey];
  return '';
}

/**
 * 解析出最终生效的调用配置。
 * 优先级：显式入参 > 环境变量 > 配置文件 > 预设默认值。
 *
 * @param {{provider?:string, model?:string, baseURL?:string, apiKey?:string,
 *          maxTokens?:number, temperature?:number, providers?:string[]}} [overrides]
 */
function resolveConfig(overrides = {}) {
  const file = readConfigFile() || {};

  const providerId =
    overrides.provider || process.env.DD_LLM_PROVIDER || file.provider || 'mock';

  const preset = PRESETS[providerId];
  if (!preset) {
    throw new LlmError(`未知的 provider：「${providerId}」。可用：${Object.keys(PRESETS).join(' / ')}`);
  }

  const model = overrides.model || process.env.DD_LLM_MODEL || file.model || preset.model || '';
  const baseURL = (overrides.baseURL || process.env.DD_LLM_BASE_URL || file.baseURL || preset.baseURL || '').replace(
    /\/+$/,
    ''
  );
  const apiKey = overrides.apiKey || envKeyFor(preset) || file.apiKey || '';

  return {
    provider: providerId,
    label: preset.label,
    kind: preset.kind,
    model,
    baseURL,
    apiKey,
    maxTokens: overrides.maxTokens || file.maxTokens || 4096,
    temperature: overrides.temperature != null ? overrides.temperature : file.temperature != null ? file.temperature : 0.7,
    // 主备降级链：前一个连续失败就切下一个
    providers: overrides.providers || file.providers || [],
    timeoutMs: overrides.timeoutMs || file.timeoutMs || 120000,
    maxRetries: overrides.maxRetries != null ? overrides.maxRetries : file.maxRetries != null ? file.maxRetries : 2,
    maxCostUsd: overrides.maxCostUsd != null ? overrides.maxCostUsd : file.maxCostUsd != null ? file.maxCostUsd : 0,
    pricing: overrides.pricing || file.pricing || PRICING,
    ready: preset.needsKey === false || !!apiKey
  };
}

/** 列出所有 provider 的可用状态，供界面下拉框使用（不含 key 本身） */
function listProviders(overrides = {}) {
  return Object.keys(PRESETS).map((id) => {
    const preset = PRESETS[id];
    const cfg = resolveConfig({ ...overrides, provider: id });
    return {
      id,
      label: preset.label,
      kind: preset.kind,
      model: cfg.model,
      needsKey: preset.needsKey !== false,
      ready: cfg.ready,
      note: cfg.ready ? '可直接使用' : `缺少 ${preset.envKey || 'API key'}`
    };
  });
}

/* ------------------------------------------------------------ token / 成本 */

/** 极粗的 token 估算：中文约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token */
function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 0x2e80 && code <= 0x9fff) cjk++;
  }
  const rest = s.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

function estimateCost(model, usage, pricing) {
  const table = pricing || PRICING;
  const p = table[model];
  if (!p || !usage) return 0;
  const inTok = usage.promptTokens || 0;
  const outTok = usage.completionTokens || 0;
  return (inTok / 1e6) * (p.in || 0) + (outTok / 1e6) * (p.out || 0);
}

/* ------------------------------------------------------------ 通用小工具 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 哪些错误值得重试：限流、服务端故障、网络抖动 */
function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/** 指数退避 + 抖动 */
function backoffMs(attempt) {
  const base = Math.min(500 * Math.pow(2, attempt), 8000);
  return base + Math.floor(Math.random() * 250);
}

/** 拼超时信号，同时尊重调用方传入的 signal */
function withTimeout(signal, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('请求超时')), timeoutMs);
  timer.unref && timer.unref();
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason);
    else signal.addEventListener('abort', () => ac.abort(signal.reason), { once: true });
  }
  return { signal: ac.signal, done: () => clearTimeout(timer) };
}

/** 把 messages 拆成 system + 对话（Anthropic 要求 system 单独传） */
function splitSystem(messages) {
  const systemParts = [];
  const rest = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else rest.push(m);
  }
  return { system: systemParts.join('\n\n'), messages: rest };
}

/* ------------------------------------------------------------ 适配器：mock */

/**
 * 本地模拟：不需要任何 key，返回确定性内容，用于跑通全流程与评测基线。
 * 通过 mockKind 区分调用方要什么（真实厂商会忽略这个字段）。
 */
function mockAdapter(cfg, req) {
  const kind = req.mockKind || 'text';
  const demoBody = [
    '<!-- mock 生成的示例页面（无 LLM，确定性输出） -->',
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>示例作品集</title>',
    '</head>',
    '<body>',
    '<main>',
    '<h1>示例作品集</h1>',
    '<p>联系方式：<a href="mailto:demo@example.com">demo@example.com</a></p>',
    '<p>电话：13800138000</p>',
    '<section><h2>作品</h2><p>占位作品内容。</p></section>',
    '</main>',
    '</body>',
    '</html>'
  ].join('\n');

  let text;
  if (kind === 'structure') {
    text = JSON.stringify(
      {
        title: '示例作品集',
        palette: { bg: '#f5f1e8', ink: '#1f2a44', accent: '#c62828' },
        sections: [
          { id: 'hero', purpose: '姓名与一句话定位' },
          { id: 'about', purpose: '基本信息' },
          { id: 'works', purpose: '作品列表' },
          { id: 'contact', purpose: '联系方式' }
        ]
      },
      null,
      2
    );
  } else if (kind === 'review') {
    text = JSON.stringify(
      {
        scores: { 概念: 7, 哲学一致性: 7, 视觉层级: 6, 细节执行: 6, 功能性: 7, 创新性: 6 },
        issues: [{ dimension: '细节执行', problem: '间距未走 8pt 网格', fix: '统一改为 8 的倍数' }],
        verdict: 'mock 评审结果，仅用于跑通流程'
      },
      null,
      2
    );
  } else if (kind === 'block') {
    // 故意带上几处合成 PII：真实场景里模型从简历生成页面必然会带出联系方式，
    // 这样 mock 也能演示「生成 → 扫描 → 脱敏」这条链
    text = [
      '<section class="block">',
      '<h2>mock 区块</h2>',
      '<p>这是模拟生成的区块内容。</p>',
      '<p>邮箱：<a href="mailto:demo@example.com">demo@example.com</a></p>',
      '<p>手机：13800138000</p>',
      '<p>微信：demo_wx_2026</p>',
      '</section>'
    ].join('\n');
  } else {
    text = demoBody;
  }

  return {
    text,
    usage: { promptTokens: estimateTokens(JSON.stringify(req.messages)), completionTokens: estimateTokens(text) },
    provider: 'mock',
    model: 'mock-1',
    latencyMs: 0,
    retries: 0
  };
}

/* ------------------------------------------------------------ 适配器：OpenAI 兼容 */

function openaiRequest(cfg, req) {
  const body = {
    model: cfg.model,
    messages: req.messages,
    max_tokens: req.maxTokens,
    temperature: req.temperature
  };
  if (req.stream) body.stream = true;
  if (req.jsonMode) body.response_format = { type: 'json_object' };

  return {
    url: cfg.baseURL + '/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + cfg.apiKey
    },
    body
  };
}

function openaiParse(data) {
  const choice = (data.choices && data.choices[0]) || {};
  const msg = choice.message || {};
  const text = typeof msg.content === 'string' ? msg.content : '';
  const u = data.usage || {};
  return {
    text,
    usage: {
      promptTokens: u.prompt_tokens || 0,
      completionTokens: u.completion_tokens || 0
    }
  };
}

/* ------------------------------------------------------------ 适配器：Anthropic */

function anthropicRequest(cfg, req) {
  const { system, messages } = splitSystem(req.messages);
  const body = {
    model: cfg.model,
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    messages
  };
  if (system) body.system = system;
  if (req.stream) body.stream = true;

  return {
    url: cfg.baseURL + '/v1/messages',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body
  };
}

function anthropicParse(data) {
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  const u = data.usage || {};
  return {
    text,
    usage: {
      promptTokens: u.input_tokens || 0,
      completionTokens: u.output_tokens || 0
    }
  };
}

/* ------------------------------------------------------------ 统一调用入口 */

const ADAPTERS = {
  openai: { request: openaiRequest, parse: openaiParse },
  anthropic: { request: anthropicRequest, parse: anthropicParse }
};

/**
 * 单轮生成（非流式），内置超时 / 重试 / 成本计量。
 *
 * @param {object} options
 * @param {{role:string, content:string}[]} options.messages
 * @param {string} [options.provider] 覆盖默认 provider
 * @param {string} [options.model]
 * @param {number} [options.maxTokens]
 * @param {number} [options.temperature]
 * @param {boolean} [options.jsonMode] OpenAI 兼容格式下要求返回 JSON 对象
 * @param {string} [options.mockKind] 仅 mock 适配器使用
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{text:string, usage:object, provider:string, model:string,
 *                    latencyMs:number, retries:number, costUsd:number}>}
 */
async function generate(options = {}) {
  const messages = options.messages || [];
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new LlmError('generate() 需要非空的 messages 数组');
  }

  const cfg = resolveConfig(options);
  const req = {
    messages,
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
    jsonMode: !!options.jsonMode,
    mockKind: options.mockKind,
    stream: false
  };

  // 降级链：把主 provider 和备用 provider 串起来依次尝试
  const chain = [cfg.provider, ...cfg.providers.filter((p) => p !== cfg.provider)];
  let lastErr = null;

  for (const providerId of chain) {
    const useCfg = providerId === cfg.provider ? cfg : resolveConfig({ ...options, provider: providerId });
    if (!useCfg.ready) {
      lastErr = new LlmError(`provider「${providerId}」未配置 API key`, { provider: providerId });
      continue;
    }
    try {
      return await callOnce(useCfg, req, options.signal);
    } catch (e) {
      lastErr = e;
      // 不可重试的错误（如 401 鉴权）也换下一家试试，可能别家有 key
    }
  }

  throw lastErr || new LlmError('没有可用的 provider');
}

async function callOnce(cfg, req, outerSignal) {
  if (cfg.kind === 'mock') {
    const r = mockAdapter(cfg, req);
    return { ...r, costUsd: 0 };
  }

  const adapter = ADAPTERS[cfg.kind];
  if (!adapter) throw new LlmError(`provider「${cfg.provider}」的适配器类型「${cfg.kind}」未实现`);

  const started = Date.now();
  let attempt = 0;
  let lastErr = null;

  while (attempt <= cfg.maxRetries) {
    const { signal, done } = withTimeout(outerSignal, cfg.timeoutMs);
    try {
      const { url, headers, body } = adapter.request(cfg, req);
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal
      });

      if (!res.ok) {
        const detail = await safeText(res);
        const retryable = isRetryableStatus(res.status);
        const err = new LlmError(
          `provider「${cfg.provider}」返回 HTTP ${res.status}：${truncate(detail, 300)}`,
          { provider: cfg.provider, status: res.status, retryable }
        );
        if (retryable && attempt < cfg.maxRetries) {
          lastErr = err;
          attempt++;
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }

      const data = await res.json();
      const parsed = adapter.parse(data);
      const usage = parsed.usage;
      const costUsd = estimateCost(cfg.model, usage, cfg.pricing);

      return {
        text: parsed.text,
        usage,
        provider: cfg.provider,
        model: cfg.model,
        latencyMs: Date.now() - started,
        retries: attempt,
        costUsd
      };
    } catch (e) {
      const isAbort = e && (e.name === 'AbortError' || (e.cause && e.cause.name === 'AbortError'));
      const retryable = isAbort || (e instanceof LlmError ? e.retryable : true);
      lastErr =
        e instanceof LlmError
          ? e
          : new LlmError(`provider「${cfg.provider}」调用失败：${e && e.message ? e.message : e}`, {
              provider: cfg.provider,
              retryable
            });
      if (retryable && attempt < cfg.maxRetries && !(outerSignal && outerSignal.aborted)) {
        attempt++;
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastErr;
    } finally {
      done();
    }
  }

  throw lastErr || new LlmError(`provider「${cfg.provider}」调用失败`);
}

/**
 * 流式生成，供界面实时显示。
 * 用法：
 *   for await (const ev of generateStream({ messages })) {
 *     if (ev.delta) process.stdout.write(ev.delta);
 *     if (ev.done) console.log('用量', ev.usage);
 *   }
 * 注意：mock 适配器会一次性吐出全部文本再发 done。
 */
async function* generateStream(options = {}) {
  const cfg = resolveConfig(options);
  const messages = options.messages || [];
  const req = {
    messages,
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
    stream: true,
    mockKind: options.mockKind
  };

  if (cfg.kind === 'mock' || !cfg.ready) {
    const r = mockAdapter(cfg, req);
    yield { delta: r.text };
    yield { delta: '', done: true, usage: r.usage, provider: r.provider, model: r.model, costUsd: 0 };
    return;
  }

  const adapter = ADAPTERS[cfg.kind];
  const { url, headers, body } = adapter.request(cfg, req);
  const { signal, done } = withTimeout(options.signal, cfg.timeoutMs);
  const started = Date.now();
  let full = '';

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok) {
      throw new LlmError(`provider「${cfg.provider}」返回 HTTP ${res.status}：${truncate(await safeText(res), 300)}`, {
        provider: cfg.provider,
        status: res.status,
        retryable: isRetryableStatus(res.status)
      });
    }
    if (!res.body) throw new LlmError('流式响应缺少 body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    for (;;) {
      const { value, done: rdone } = await reader.read();
      if (rdone) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 以行为单位；\n\n 分隔事件，这里逐行处理足够稳
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let evt;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }

        const piece = extractDelta(cfg.kind, evt);
        if (piece) {
          full += piece;
          yield { delta: piece };
        }
      }
    }
  } finally {
    done();
  }

  const usage = {
    promptTokens: estimateTokens(JSON.stringify(messages)),
    completionTokens: estimateTokens(full)
  };
  yield {
    delta: '',
    done: true,
    usage,
    provider: cfg.provider,
    model: cfg.model,
    latencyMs: Date.now() - started,
    costUsd: estimateCost(cfg.model, usage, cfg.pricing)
  };
}

/** 从不同厂商的流式事件里取出增量文本 */
function extractDelta(kind, evt) {
  if (kind === 'openai') {
    const c = evt.choices && evt.choices[0];
    if (c && c.delta && typeof c.delta.content === 'string') return c.delta.content;
    return '';
  }
  if (kind === 'anthropic') {
    if (evt.type === 'content_block_delta' && evt.delta && typeof evt.delta.text === 'string') {
      return evt.delta.text;
    }
    return '';
  }
  return '';
}

/* ------------------------------------------------------------ 小工具 */

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

module.exports = {
  LlmError,
  PRESETS,
  PRICING,
  resolveConfig,
  listProviders,
  generate,
  generateStream,
  estimateTokens,
  estimateCost
};
