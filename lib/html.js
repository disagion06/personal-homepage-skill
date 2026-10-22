'use strict';
/**
 * 轻量 HTML 解析 / 安全改写。
 *
 * 为什么不用正则替换：`<script>` 里常见 `a < b`，`<style>` 里常见 `content:"<"`，
 * 用 `<[^>]*>` 这类正则会把它们当成标签，导致脱敏时把页面改坏。
 * 因此这里实现一个带状态的扫描器：能精确知道每个字符落在「标签内 / 属性值 / 文本节点 /
 * 注释 / 脚本正文」中的哪一种，从而保证：
 *   - 只改文本与属性值，绝不动标签结构；
 *   - 需要时能安全地整段删除某个标签或给元素加属性。
 */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAWTEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);
/** 命中这些 class 关键字时视为「卡片 / 条目」，用于「隐藏整块」 */
const CARD_CLASS_RE = /(?:^|[\s_-])(?:item|card|row|cell|field|entry|block|panel|figure|media|thumb|work|profile|contact|info)(?:$|[\s_-])/i;

/** 从 from 起找到标签结束的 '>'，跳过引号内的内容 */
function findTagEnd(html, from) {
  let quote = null;
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i + 1;
  }
  return html.length;
}

/** 解析标签内部的属性，返回带位置的属性列表 */
function parseAttrs(html, nameEnd, tagEnd) {
  const attrs = [];
  const src = html.slice(nameEnd, tagEnd);
  const re = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>`]+))?/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    if (!name || name === '/' || name === '>') continue;
    const raw = m[2];
    const nameStart = nameEnd + m.index;
    let valueStart = -1;
    let valueEnd = -1;
    let quote = '';
    if (raw !== undefined) {
      const eqIdx = src.indexOf('=', m.index + name.length);
      if (eqIdx >= 0) {
        const q = src[eqIdx + 1];
        if (q === '"' || q === "'") {
          quote = q;
          valueStart = nameEnd + eqIdx + 2;
          valueEnd = valueStart + raw.length - 2;
        } else {
          valueStart = nameEnd + eqIdx + 1;
          valueEnd = valueStart + raw.length;
        }
      }
    }
    attrs.push({ name: name.toLowerCase(), rawName: name, nameStart, nameEnd: nameStart + name.length, valueStart, valueEnd, quote, rawValue: raw === undefined ? null : raw });
  }
  return attrs;
}

/**
 * 解析 HTML，返回 token 列表与元素树信息。
 * @returns {{tokens:Array, elements:Array, length:number}}
 */
function parse(html) {
  const tokens = [];
  const elements = [];
  const stack = [];
  const len = html.length;
  let i = 0;

  const pushText = (start, end, type = 'text', name = null) => {
    if (end <= start) return;
    const t = { type, name, start, end, parent: stack.length ? stack[stack.length - 1] : -1 };
    tokens.push(t);
    return t;
  };

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      pushText(i, len);
      break;
    }
    if (lt > i) pushText(i, lt);

    // 注释
    if (html.startsWith('<!--', lt)) {
      let end = html.indexOf('-->', lt + 4);
      end = end < 0 ? len : end + 3;
      pushText(lt, end, 'comment');
      i = end;
      continue;
    }
    // CDATA / doctype / 处理指令
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = findTagEnd(html, lt);
      pushText(lt, end, 'doctype');
      i = end;
      continue;
    }
    // 结束标签
    if (html[lt + 1] === '/') {
      const m = /^<\/\s*([a-zA-Z][\w:.-]*)/.exec(html.slice(lt, lt + 80));
      const end = findTagEnd(html, lt);
      const name = m ? m[1].toLowerCase() : '';
      const t = { type: 'tag', name, start: lt, end, closing: true, selfClosing: false, attrs: [], parent: stack.length ? stack[stack.length - 1] : -1, index: -1 };
      tokens.push(t);
      // 出栈
      for (let s = stack.length - 1; s >= 0; s--) {
        const idx = stack[s];
        if (elements[idx].name === name) {
          elements[idx].closeStart = lt;
          elements[idx].closeEnd = end;
          stack.length = s;
          break;
        }
      }
      i = end;
      continue;
    }
    // 开始标签
    const nameMatch = /^<([a-zA-Z][\w:.-]*)/.exec(html.slice(lt, lt + 120));
    if (!nameMatch) {
      // 孤立的 '<'：当普通文本
      pushText(lt, lt + 1);
      i = lt + 1;
      continue;
    }
    const end = findTagEnd(html, lt);
    const name = nameMatch[1].toLowerCase();
    const nameEnd = lt + 1 + nameMatch[1].length;
    const selfClosing = /\/\s*>$/.test(html.slice(lt, end)) || VOID_TAGS.has(name);
    const el = {
      type: 'tag',
      name,
      start: lt,
      end,
      nameEnd,
      closing: false,
      selfClosing,
      attrs: parseAttrs(html, nameEnd, end),
      parent: stack.length ? stack[stack.length - 1] : -1,
      index: elements.length,
      innerStart: end,
      innerEnd: -1,
      closeStart: -1,
      closeEnd: -1,
      depth: stack.length
    };
    tokens.push(el);
    elements.push(el);
    if (!selfClosing && !RAWTEXT_TAGS.has(name)) stack.push(el.index);

    if (!selfClosing && RAWTEXT_TAGS.has(name)) {
      // 脚本 / 样式 / 文本域 / 标题：内容是原样文本，直到对应的结束标签
      const closeRe = new RegExp('</' + name + '\\s*>', 'i');
      const rest = html.slice(end);
      const cm = closeRe.exec(rest);
      const contentEnd = cm ? end + cm.index : len;
      pushText(end, contentEnd, 'rawtext', name);
      if (cm) {
        const cStart = contentEnd;
        const cEnd = contentEnd + cm[0].length;
        el.closeStart = cStart;
        el.closeEnd = cEnd;
        el.innerEnd = cStart;
        const t = { type: 'tag', name, start: cStart, end: cEnd, closing: true, selfClosing: false, attrs: [], parent: el.parent, index: -1 };
        tokens.push(t);
        i = cEnd;
      } else {
        el.innerEnd = len;
        i = len;
      }
      continue;
    }
    i = end;
  }

  return { tokens, elements, length: len };
}

/** 二分查找包含该位置的 token */
function tokenAt(tokens, index) {
  let lo = 0;
  let hi = tokens.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = tokens[mid];
    if (index < t.start) hi = mid - 1;
    else if (index >= t.end) lo = mid + 1;
    else return t;
  }
  return null;
}

/**
 * 判断某个字符区间落在哪里。
 * @returns {{kind:'text'|'attr'|'tag'|'comment'|'doctype'|'rawtext', token:object, element:object|null, attr:object|null}}
 */
function locate(parsed, index) {
  const t = tokenAt(parsed.tokens, index);
  if (!t) return { kind: 'unknown', token: null, element: null, attr: null };
  if (t.type === 'comment') return { kind: 'comment', token: t, element: null, attr: null };
  if (t.type === 'doctype') return { kind: 'doctype', token: t, element: null, attr: null };
  if (t.type === 'rawtext') {
    const el = t.parent >= 0 ? parsed.elements[t.parent] : null;
    return { kind: 'rawtext', token: t, element: el, attr: null };
  }
  if (t.type === 'tag') {
    for (const a of t.attrs) {
      if (a.valueStart >= 0 && index >= a.valueStart && index < a.valueEnd) {
        return { kind: 'attr', token: t, element: t.closing ? null : t, attr: a };
      }
    }
    return { kind: 'tag', token: t, element: t.closing ? null : t, attr: null };
  }
  const el = t.parent >= 0 ? parsed.elements[t.parent] : null;
  return { kind: 'text', token: t, element: el, attr: null };
}

/** 应用一组编辑（区间不重叠），返回新字符串 */
function applyEdits(html, edits) {
  const list = edits.filter((e) => e && e.end >= e.start).slice().sort((a, b) => b.start - a.start || b.end - a.end);
  let out = html;
  let lastStart = Infinity;
  for (const e of list) {
    if (e.end > lastStart) continue; // 跳过与已处理区间重叠的编辑
    out = out.slice(0, e.start) + (e.text == null ? '' : e.text) + out.slice(e.end);
    lastStart = e.start;
  }
  return out;
}

/** 去掉标签与注释，只剩可见文本 */
function stripTags(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '');
}

/** 给某个元素插入/覆盖属性（返回一个 edit） */
function editSetAttr(html, el, name, value) {
  const existing = el.attrs.find((a) => a.name === name.toLowerCase());
  if (existing && existing.valueStart >= 0) {
    return { start: existing.valueStart, end: existing.valueEnd, text: value, __kind: 'attr-value' };
  }
  if (existing) {
    return { start: existing.nameEnd, end: existing.nameEnd, text: '="' + value + '"', __kind: 'attr-add-value' };
  }
  return { start: el.nameEnd, end: el.nameEnd, text: ' ' + name + '="' + value + '"', __kind: 'attr-add' };
}

/** 该元素（含所有后代）去掉标签后的文本，先按 edits 做预演 */
function innerTextAfter(html, el, edits = []) {
  const innerEnd = el.innerEnd >= 0 ? el.innerEnd : el.closeStart >= 0 ? el.closeStart : el.end;
  const start = el.innerStart;
  const end = innerEnd;
  // 只取完全落在 inner 区间内的编辑
  const inside = edits.filter((e) => e.start >= start && e.end <= end);
  const segs = inside.slice().sort((a, b) => a.start - b.start);
  let out = '';
  let pos = start;
  for (const e of segs) {
    if (e.start < pos) continue;
    out += html.slice(pos, e.start);
    out += e.text == null ? '' : e.text;
    pos = e.end;
  }
  out += html.slice(pos, end);
  return stripTags(out).replace(/\s+/g, ' ').trim();
}

/** 找到最近的「卡片 / 条目」祖先元素（找不到返回 null，调用方自行决定兜底） */
function cardAncestor(parsed, el, maxUp = 6) {
  if (!el) return null;
  let cur = el;
  for (let i = 0; i < maxUp; i++) {
    if (!cur) break;
    const cls = (cur.attrs || []).find((a) => a.name === 'class');
    const clsVal = cls && cls.rawValue ? cls.rawValue.replace(/^["']|["']$/g, '') : '';
    if (clsVal && CARD_CLASS_RE.test(clsVal)) return cur;
    if (cur.parent < 0) break;
    const parent = parsed.elements[cur.parent];
    if (!parent) break;
    if (['body', 'main', 'html'].includes(parent.name)) break;
    cur = parent;
  }
  return null;
}

/** 找出引用了某个相对路径的全部元素（img/video/source/a/link/css url） */
function findRefElements(parsed, relPath) {
  const needle = relPath.replace(/\\/g, '/');
  const bare = needle.split('/').pop();
  const hits = [];
  for (const el of parsed.elements) {
    if (el.closing) continue;
    for (const a of el.attrs) {
      if (a.valueStart < 0 || !a.rawValue) continue;
      const v = a.rawValue.replace(/^["']|["']$/g, '').replace(/\\/g, '/');
      if (!v) continue;
      if (v === needle || v.endsWith('/' + needle) || v === bare || v.endsWith('/' + bare) || v.includes(needle) || (bare && v.includes(bare))) {
        hits.push({ element: el, attr: a.name, attrObj: a, value: v });
      }
    }
  }
  return hits;
}

module.exports = {
  parse,
  locate,
  applyEdits,
  stripTags,
  innerTextAfter,
  cardAncestor,
  findRefElements,
  editSetAttr,
  tokenAt,
  VOID_TAGS,
  RAWTEXT_TAGS,
  CARD_CLASS_RE
};
