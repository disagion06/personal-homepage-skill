'use strict';
/**
 * 敏感信息规则库。
 *
 * 每条规则：
 *   id / label / category / severity / reason
 *   defaultAction: 'mask' | 'keep'
 *   pattern?: 全局正则
 *   capture?: 只处理第 N 个捕获组（默认 0 = 整个匹配）
 *   gate?(m, ctx): 布尔，做上下文二次确认，过滤误报
 *   mask(value, ctx): 打码后的字符串
 *   detect?(text, ctx): 自定义检测，返回 [{start, end, value}]（用于姓名这类正则不好搞的）
 *
 * ctx = { html, index, parsed, loc, file, parentText(), elementText() }
 */

const { escapeHtml } = require('./util');

/* ------------------------------------------------------------ 打码工具 */

function keepHeadTail(v, head, tail, filler = '*') {
  const s = String(v);
  if (s.length <= head + tail) return filler.repeat(Math.max(3, s.length));
  return s.slice(0, head) + filler.repeat(s.length - head - tail) + s.slice(s.length - tail);
}

function maskEmail(v) {
  const at = String(v).indexOf('@');
  if (at <= 0) return '***';
  const local = String(v).slice(0, at);
  const domain = String(v).slice(at);
  const head = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
  return head + '***' + domain;
}

function maskMobile(v) {
  const digits = String(v).replace(/\D/g, '');
  if (digits.length < 7) return '****';
  return digits.slice(0, 3) + '****' + digits.slice(-4);
}

function maskCnName(v) {
  const s = String(v).trim();
  if (s.length <= 1) return '*';
  return s[0] + '*'.repeat(s.length - 1);
}

function maskEnName(v) {
  return String(v)
    .split(/\s+/)
    .map((w) => (w.length <= 1 ? w : w[0] + '*'.repeat(w.length - 1)))
    .join(' ');
}

function luhnOk(num) {
  const s = String(num).replace(/\D/g, '');
  if (s.length < 12) return false;
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/* ------------------------------------------------------------ 常量表 */

const SURNAMES =
  '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫房裘缪解应宗丁宣邓郁单杭洪包诸左石崔吉钮龚程邢裴陆荣翁荀羊惠甄曲家封芮储靳段富巫乌焦巴牧山谷车侯全班仰秋仲伊宫宁仇栾甘厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰鄂索咸赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳姬申扶堵冉宰郦雍桑桂濮牛寿通边扈燕冀浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩聂晁勾敖融冷辛阚那简饶空曾毋沙养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓';
const DOUBLE_SURNAMES = ['欧阳', '太史', '端木', '上官', '司马', '东方', '独孤', '南宫', '万俟', '闻人', '夏侯', '诸葛', '尉迟', '公羊', '赫连', '澹台', '皇甫', '宗政', '濮阳', '公冶', '太叔', '申屠', '公孙', '慕容', '仲孙', '钟离', '长孙', '宇文', '司徒', '鲜于', '司空', '闾丘', '子车', '亓官', '司寇', '巫马', '公西', '颛孙', '壤驷', '公良', '漆雕', '乐正', '宰父', '谷梁', '拓跋', '夹谷', '轩辕', '令狐', '段干', '百里', '呼延', '东郭', '南门', '羊舌', '微生', '公户', '公玉', '公仪', '梁丘', '公仲', '公上', '公门', '公山', '公坚', '左丘', '公伯', '西门', '公祖', '第五', '公乘', '贯丘', '公皙', '南荣', '东里', '东宫', '仲长', '子书', '子桑', '即墨', '达奚', '褚师'];

/** 常见城市（用于「位置信息」类提示，默认保留） */
const CITIES = [
  '北京', '上海', '天津', '重庆', '广州', '深圳', '杭州', '南京', '武汉', '成都', '西安', '苏州', '郑州', '长沙', '青岛', '沈阳', '大连', '厦门', '福州', '济南', '合肥', '南昌', '贵阳', '南宁', '海口', '兰州', '西宁', '银川', '乌鲁木齐', '呼和浩特', '拉萨', '石家庄', '太原', '长春', '哈尔滨', '无锡', '宁波', '佛山', '东莞', '珠海', '中山', '惠州', '温州', '绍兴', '嘉兴', '泉州', '烟台', '潍坊', '徐州', '常州', '南通', '唐山', '洛阳', '保定', '临沂', '包头', '柳州', '桂林', '三亚', '遵义', '绵阳', '大理', '丽江', '曲靖', '玉溪', '楚雄', '昆明'
];

/** 姓名误报黑名单（避免把「中国」「人民日报」之类当成人名） */
const NAME_STOP = new Set([
  '中国', '人民', '时间', '设计', '作品', '昆明', '云南', '大学', '学院', '公司', '有限', '集团', '工作', '简历', '个人', '新媒体', '运营', '数字', '媒体', '技术', '内容', '创作', '策划', '活动', '数据', '整理', '能力', '经验', '姓名', '联系', '方式', '邮箱', '电话', '地址', '作品集', '项目', '视频', '广告', '海报', '平面', '摄影', '剪辑', '课程', '专业', '本科', '在读', '排名', '主要', '荣誉', '技能', '自我', '评价', '教育', '背景', '基本', '信息', '求职', '意向', '编者', '按语', '全部', '图片', '可以', '点击', '播放', '放大', '注：', '个人简历'
]);

const CATEGORY = {
  CONTACT: '联系方式',
  IDENTITY: '身份信息',
  CREDENTIAL: '账号凭据',
  LOCATION: '位置信息',
  CAREER: '教育职业',
  IMAGE: '图片'
};

/* ------------------------------------------------------------ 姓名检测 */

const SINGLE_SURNAME_CLASS = '[' + SURNAMES + ']';
const ANY_SURNAME = '(?:' + DOUBLE_SURNAMES.join('|') + '|' + SINGLE_SURNAME_CLASS + ')';
/** 名字后面常见的「人名线索词」：只有跟着这些词，纯姓名猜测才算可信 */
const NAME_TAIL = '(?:的个人简历|个人简历|的简历|工作照|生活照|证件照|个人照|的同学|同学|先生|女士|老师|的个人作品集|的作品集|·\\s*个人)';
/** 元素 class / id 里的人名线索 */
const NAME_CLASS_RE = /(?:^|[\s_-])(?:hero-name|author-name|author|f-name|profile-name|sign-name|self-name|real-name|user-name|name)(?:$|[\s_-])/i;
/** 结构化姓名所在容器的 class 线索（宽松一些，配合内容校验使用） */
const NAME_CLASS_LOOSE_RE = /(?:hero-name|author|f-name|profile-name|sign-name|self-name|real-name)/i;

function looksLikeCnName(v) {
  if (!v || v.length < 2 || v.length > 4) return false;
  if (NAME_STOP.has(v)) return false;
  if (DOUBLE_SURNAMES.some((d) => v.startsWith(d))) return v.length >= 3;
  return SURNAMES.includes(v[0]);
}

/** 语境明确的中文姓名：姓名：X / 作者 X / X · 个人简历 / X 工作照 … */
function detectExplicitNames(text) {
  const out = [];
  const push = (m, groupIdx) => {
    const v = m[groupIdx];
    if (!looksLikeCnName(v)) return;
    const s = m.index + m[0].indexOf(v);
    out.push({ start: s, end: s + v.length, value: v });
  };
  let m;
  const preRe = /(?:姓名|真实姓名|作者|撰文|签名|指导教师|指导老师|导师|负责人|联系人|班主任)\s*[:：=]?\s*([\u4e00-\u9fa5]{2,4})/g;
  while ((m = preRe.exec(text))) push(m, 1);

  const postRe = new RegExp('(' + ANY_SURNAME + '[\\u4e00-\\u9fa5]{1,3})\\s*' + NAME_TAIL, 'g');
  while ((m = postRe.exec(text))) push(m, 1);

  // <meta name="author" content="王小明"> / alt="王小明工作照"
  const attrRe = new RegExp('(?:content|alt|title)\\s*=\\s*["\']([\\u4e00-\\u9fa5]{2,4})\\s*' + NAME_TAIL, 'g');
  while ((m = attrRe.exec(text))) push(m, 1);

  return out;
}

/** 结构化姓名：<h1 class="hero-name">杨<b>国鑫</b></h1> —— 名字被标签拆开也认得出 */
function detectStructuralNames(text, ctx = {}) {
  const parsed = ctx.parsed;
  if (!parsed) return [];
  const out = [];
  const seen = new Set();
  for (const el of parsed.elements) {
    if (el.closing || el.selfClosing) continue;
    const cls = el.attrs.find((a) => a.name === 'class');
    const id = el.attrs.find((a) => a.name === 'id');
    const hay = [cls && cls.rawValue, id && id.rawValue].filter(Boolean).join(' ');
    if (!hay || !NAME_CLASS_LOOSE_RE.test(hay)) continue;

    const end = el.closeStart >= 0 ? el.closeStart : el.innerEnd >= 0 ? el.innerEnd : el.end;
    // 该元素的直接文本内容（跳过 script/style 与注释）
    let buffer = '';
    const map = [];
    for (const t of parsed.tokens) {
      if (t.start < el.innerStart || t.end > end) continue;
      if (t.type !== 'text') continue;
      const parentIsSelf = t.parent === el.index;
      if (!parentIsSelf && !NAME_CLASS_LOOSE_RE.test(hay)) continue;
      for (let i = t.start; i < t.end; i++) {
        buffer += text[i];
        map.push(i);
      }
    }
    const value = buffer.replace(/\s+/g, '');
    if (!looksLikeCnName(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);

    // 把「去掉空白后的字符」映射回原文区间
    const kept = [];
    for (let i = 0; i < buffer.length; i++) if (!/\s/.test(buffer[i])) kept.push(map[i]);
    const ranges = [];
    for (const idx of kept) {
      const last = ranges[ranges.length - 1];
      if (last && last.end === idx) last.end = idx + 1;
      else ranges.push({ start: idx, end: idx + 1 });
    }
    if (!ranges.length) continue;
    out.push({ start: kept[0], end: kept[kept.length - 1] + 1, value, ranges });
  }
  return out;
}

/** 纯猜测：百家姓开头的 2~4 字组合，仅在人名语境的 DOM 位置上采纳 */
function detectGuessedNames(text) {
  const out = [];
  const re = new RegExp('(?<![\\u4e00-\\u9fa5])(' + ANY_SURNAME + '[\\u4e00-\\u9fa5]{2,3})(?![\\u4e00-\\u9fa5])', 'g');
  let m;
  while ((m = re.exec(text))) {
    const v = m[1];
    if (!looksLikeCnName(v)) continue;
    if (NAME_STOP.has(v)) continue;
    out.push({ start: m.index, end: m.index + v.length, value: v });
  }
  return out;
}

/** 猜测型姓名的二次确认：必须处在人名语境的 DOM 位置 */
function guessedNameGate(m, ctx) {
  const value = m[0];
  const before = ctx.before || '';
  const after = ctx.after || '';
  const loc = ctx.loc || {};
  // 1) 紧跟人名线索词
  if (/^[\s\u3000]{0,2}(?:的个人简历|个人简历|工作照|证件照|生活照|个人照|同学|先生|女士)/.test(after)) return true;
  // 2) 前面 20 字内出现姓名引导词
  if (/(?:姓名|作者|签名|指导教师|指导老师|导师|联系人|负责人)\s*[:：=]?\s*$/.test(before.slice(-20))) return true;
  // 3) 处在意为「人名」的属性里，且属性值带人名线索词
  if (loc.kind === 'attr' && /^(alt|title|content|data-name)$/.test(loc.attr && loc.attr.name)) {
    const raw = (loc.attr.rawValue || '').replace(/^["']|["']$/g, '');
    if (new RegExp('^[\\u4e00-\\u9fa5]{2,4}\\s*' + NAME_TAIL).test(raw)) return true;
  }
  // 4) 处在意为人名的元素里
  if (ctx.ownerClassText && NAME_CLASS_RE.test(ctx.ownerClassText)) return true;
  return false;
}

/** 英文姓名：Signed, Yang Guoxin / By John Smith */
function detectEnNames(text) {
  const out = [];
  const re = /(?:Signed,?|By|Author|Designed by)\s*:?\s*([A-Z][a-zA-Z]{1,15}(?:\s+[A-Z][a-zA-Z]{1,15}){1,2})/g;
  let m;
  while ((m = re.exec(text))) {
    const v = m[1];
    const s = m.index + m[0].length - v.length;
    out.push({ start: s, end: s + v.length, value: v });
  }
  return out;
}

/* ------------------------------------------------------------ 规则表 */

const RULES = [
  {
    id: 'secret_key',
    label: '密钥 / 访问令牌',
    category: CATEGORY.CREDENTIAL,
    severity: 'high',
    reason: '疑似 API Key、GitHub Token 或云服务密钥，一旦公开可被他人直接盗用。',
    defaultAction: 'mask',
    pattern:
      /(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{6,})/g,
    mask: () => '[已移除的密钥]'
  },
  {
    id: 'private_key',
    label: '私钥文件内容',
    category: CATEGORY.CREDENTIAL,
    severity: 'high',
    reason: '私钥绝不能出现在公开仓库里。',
    defaultAction: 'mask',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    mask: () => '[已移除的私钥]'
  },
  {
    id: 'url_token',
    label: 'URL 里携带的令牌',
    category: CATEGORY.CREDENTIAL,
    severity: 'high',
    reason: '查询参数中的 token / key / secret 会随链接泄露。',
    defaultAction: 'mask',
    pattern: /[?&](?:token|access_token|key|apikey|api_key|secret|password|pwd|sign|signature)=([A-Za-z0-9._~%\-+/=]{8,})/gi,
    capture: 1,
    mask: () => '[已移除]'
  },
  {
    id: 'id_card',
    label: '身份证号',
    category: CATEGORY.IDENTITY,
    severity: 'high',
    reason: '身份证号属于最高等级的个人身份信息。',
    defaultAction: 'mask',
    pattern: /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g,
    mask: (v) => keepHeadTail(v, 6, 4)
  },
  {
    id: 'bank_card',
    label: '银行卡 / 账号',
    category: CATEGORY.IDENTITY,
    severity: 'high',
    reason: '长数字串且通过银行卡校验，疑似银行卡号。',
    defaultAction: 'mask',
    pattern: /(?<!\d)\d{16,19}(?!\d)/g,
    gate: (m) => luhnOk(m[0]),
    mask: (v) => '**** **** **** ' + String(v).slice(-4)
  },
  {
    id: 'mobile_cn',
    label: '手机号码',
    category: CATEGORY.CONTACT,
    severity: 'high',
    reason: '完整手机号可直接被用于骚扰、诈骗或撞库。',
    defaultAction: 'mask',
    pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    mask: maskMobile
  },
  {
    id: 'mobile_masked',
    label: '已部分打码的手机号',
    category: CATEGORY.CONTACT,
    severity: 'medium',
    reason: '中间位已用星号遮挡，通常可保留；若想彻底隐藏可改为打码或删除。',
    defaultAction: 'keep',
    pattern: /(?<!\d)1[3-9]\d[\s\-*＊·•xX×]{1,8}\d{4}(?!\d)/g,
    mask: maskMobile
  },
  {
    id: 'email',
    label: '邮箱地址',
    category: CATEGORY.CONTACT,
    severity: 'medium',
    reason: '公开邮箱会被爬虫抓取用于垃圾邮件；求职场景可保留。',
    defaultAction: 'mask',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
    mask: maskEmail
  },
  {
    id: 'qq',
    label: 'QQ 号',
    category: CATEGORY.CONTACT,
    severity: 'medium',
    reason: 'QQ 号常与密码找回、社交账号绑定，属于可被利用的联系方式。',
    defaultAction: 'mask',
    pattern: /(?<!\d)\d{5,11}(?!\d)/g,
    gate: (m, ctx) => /(?:QQ|qq|Q Q|扣扣|企鹅|腾讯)\s*(?:号|ID|id)?\s*[:：=]?\s*$/.test(ctx.before) || /^\s*(?:号)?\s*(?:QQ|qq)/.test(ctx.after),
    mask: (v) => keepHeadTail(v, 3, 0)
  },
  {
    id: 'wechat',
    label: '微信号',
    category: CATEGORY.CONTACT,
    severity: 'high',
    reason: '微信号可直接加好友，是强骚扰入口。',
    defaultAction: 'mask',
    pattern: /(?:微信号|微信ID|WeChat\s*ID|wechat|微信|vx|VX|v信|威信)\s*(?:号|ID|id)?\s*[:：=]?\s*([A-Za-z][-_A-Za-z0-9]{5,19})/g,
    capture: 1,
    mask: (v) => keepHeadTail(v, 2, 0)
  },
  {
    id: 'name_cn',
    label: '中文姓名',
    category: CATEGORY.IDENTITY,
    severity: 'high',
    reason: '姓名是最核心的身份标识，配合其他信息可精确定位到个人。',
    defaultAction: 'mask',
    detect: detectExplicitNames,
    detectMarkup: detectStructuralNames,
    mask: maskCnName
  },
  {
    id: 'name_guess',
    label: '疑似姓名（请人工确认）',
    category: CATEGORY.IDENTITY,
    severity: 'medium',
    reason: '由姓氏推断出的疑似人名，可能是正文里的普通词语，默认保留，确认是本人姓名后再改为打码。',
    defaultAction: 'keep',
    detect: detectGuessedNames,
    gate: guessedNameGate,
    mask: maskCnName
  },
  {
    id: 'name_en',
    label: '英文 / 拼音姓名',
    category: CATEGORY.IDENTITY,
    severity: 'medium',
    reason: '英文或拼音姓名同样能定位到个人。',
    defaultAction: 'mask',
    detect: (text) => detectEnNames(text),
    mask: maskEnName
  },
  {
    id: 'birth_date',
    label: '出生年月',
    category: CATEGORY.IDENTITY,
    severity: 'medium',
    reason: '出生日期常被用作账号验证信息，建议隐藏月份。',
    defaultAction: 'mask',
    pattern: /(?<!\d)(?:19|20)\d{2}\s*[.\-/年]\s*(?:0?[1-9]|1[0-2])\s*月?(?!\d)/g,
    gate: (m, ctx) => {
      if (/(?:出生|生日|生于|年龄|born|Birth)/i.test(ctx.before.slice(-140))) return true;
      const parentText = ctx.parentText ? ctx.parentText() : '';
      return /(?:出生|生日|生于|年龄)/.test(parentText);
    },
    mask: (v) => String(v).replace(/([.\-/年])\s*(?:1[0-2]|0?[1-9])(?=\s*月|$|\D)/, '$1**')
  },
  {
    id: 'address_full',
    label: '详细住址',
    category: CATEGORY.LOCATION,
    severity: 'high',
    reason: '精确到门牌号的地址会直接暴露居住或工作地点。',
    defaultAction: 'mask',
    pattern: /[\u4e00-\u9fa5]{2,10}(?:省|自治区|市)[\u4e00-\u9fa5]{2,12}(?:区|县|市|镇)[\u4e00-\u9fa5\d]{2,30}(?:号|楼|室|栋|单元|小区|大厦|公寓|花园)|[\u4e00-\u9fa5]{2,12}(?:路|街|大道|巷)\s*\d{1,4}\s*号[\u4e00-\u9fa5\d]{0,20}/g,
    mask: (v) => String(v).slice(0, 2) + '**（详细地址已隐藏）'
  },
  {
    id: 'student_id',
    label: '学号 / 工号',
    category: CATEGORY.IDENTITY,
    severity: 'high',
    reason: '学号工号可用于登录学校或公司系统。',
    defaultAction: 'mask',
    pattern: /(?:学号|学\s*号|准考证号|工号|员工编号|账号)\s*[:：=]?\s*(\d{5,20})/g,
    capture: 1,
    mask: (v) => keepHeadTail(v, 2, 2)
  },
  {
    id: 'city',
    label: '城市 / 所在地区',
    category: CATEGORY.LOCATION,
    severity: 'low',
    reason: '城市级位置信息敏感度较低，但和姓名组合后可用于定位；可自行决定是否隐藏。',
    defaultAction: 'keep',
    detect: (text) => {
      const out = [];
      for (const c of CITIES) {
        let idx = text.indexOf(c);
        while (idx >= 0) {
          out.push({ start: idx, end: idx + c.length, value: c });
          idx = text.indexOf(c, idx + c.length);
        }
      }
      return out;
    },
    mask: (v) => String(v)[0] + '*'.repeat(Math.max(1, String(v).length - 1))
  },
  {
    id: 'school',
    label: '学校名称',
    category: CATEGORY.CAREER,
    severity: 'low',
    reason: '学校名称多为求职时的公开信息，作品集里通常保留；如担心被社工可隐藏。',
    defaultAction: 'keep',
    pattern: /[\u4e00-\u9fa5]{2,12}(?:大学|学院|职业技术学院|职业学院|高级中学|中学)/g,
    gate: (m) => !/(?:全国|全省|全市|大赛|比赛|优秀|评选|排行|涉及|包括|以及|等$)/.test(m[0]) && !/^第/.test(m[0]) && m[0].length <= 14,
    mask: () => '某学校'
  },
  {
    id: 'company',
    label: '公司 / 单位名称',
    category: CATEGORY.CAREER,
    severity: 'low',
    reason: '公司名称可能暴露内部项目或客户信息。',
    defaultAction: 'keep',
    pattern: /[\u4e00-\u9fa5]{2,15}(?:有限公司|有限责任公司|股份有限公司|集团|工作室|研究院)/g,
    mask: () => '某公司'
  },
  {
    id: 'gender_ethnic',
    label: '性别 / 民族',
    category: CATEGORY.IDENTITY,
    severity: 'low',
    reason: '属于个人基本信息，作品集里常见，可自行决定。',
    defaultAction: 'keep',
    pattern: /(?:男|女)\s*[·、\/]\s*[\u4e00-\u9fa5]{2,8}族?/g,
    mask: () => '已隐藏'
  },
  {
    id: 'social_handle',
    label: '社交平台账号',
    category: CATEGORY.CONTACT,
    severity: 'low',
    reason: '社交主页链接会关联到更多个人信息。',
    defaultAction: 'keep',
    pattern: /(?:github\.com|gitee\.com|weibo\.com|zhihu\.com|douyin\.com|xiaohongshu\.com|bilibili\.com|behance\.net|dribbble\.com)\/[@A-Za-z0-9_.\-]{2,40}/gi,
    mask: (v) => String(v).replace(/\/[@A-Za-z0-9_.\-]{2,40}$/, '/[已隐藏]')
  }
];

/** 用户自定义关键词 → 动态规则 */
function makeCustomRule(keywords) {
  const list = (keywords || []).map((k) => String(k).trim()).filter((k) => k.length >= 2);
  if (!list.length) return null;
  const escaped = list.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return {
    id: 'custom',
    label: '自定义关键词',
    category: CATEGORY.IDENTITY,
    severity: 'high',
    reason: '由你自己添加的关键词，命中即视为敏感信息。',
    defaultAction: 'mask',
    pattern: new RegExp('(' + escaped.join('|') + ')', 'g'),
    mask: (v) => String(v)[0] + '*'.repeat(Math.max(1, String(v).length - 1))
  };
}

module.exports = {
  RULES,
  CATEGORY,
  makeCustomRule,
  keepHeadTail,
  maskEmail,
  maskMobile,
  maskCnName,
  luhnOk,
  CITIES,
  SURNAMES,
  NAME_STOP,
  escapeHtml
};
