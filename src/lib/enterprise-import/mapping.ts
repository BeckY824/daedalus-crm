/**
 * 猜映射：原系统的列名 / 值 / 负责人写法 → 我们的字段 / 值 / 成员。
 *
 * 先走规则（别名表、同义词、按名字 / 邮箱认人），规则认不出的才问 AI——发给 AI 的只有
 * 「规则没认出来的那几个列名 + 打过码的几格样例」「没认出来的值」「没认出来的负责人写法」，
 * 不发整表。AI 回来的每一项都要过校验：字段必须是这一类有的、值必须是我们的合法值、人必须在候选名单里，
 * 不合法的当没说。
 *
 * AI 用客户自己的 Key（getLlmConfig）。没配 Key 就只走规则，报告里说一声。
 * 测试不花钱：ENT_IMPORT_AI=mock 走下面的 模拟建议，或者调用方直接传一个 建议器 进来。
 *
 * 猜出来的是建议，试跑报告里人都能改；正式导入和之后的同步照人确认过的那一份走。
 */
import { FOLLOW_STATUSES, FOLLOW_TYPES, LEAD_STATUSES, OPP_STAGES } from "../constants";
import { 规整表头 } from "../import/fields";
import { 认枚举 } from "../import/plan";
import { 阶段值, type BusinessConfig } from "../business-config";
import { 标准字段, 字段中文, 实体名, type 原始记录, type 实体, type 列映射, type 映射, type 值对照名 } from "./types";

/** 列映射里的特殊值：这一列不单独落字段，「表头：值」拼进备注（跟进拼进内容），一格信息都不丢 */
export const 进备注 = "+remark";

/** 输单不是我们的一个阶段，是商机状态 LOST；阶段对照里用这个词表示 */
export const 输单 = "输单";

type 业务 = Pick<BusinessConfig, "template" | "stageLabels" | "statusLabels"> | null | undefined;

/**
 * 每一类的别名表：标准字段 → 原系统可能的叫法。比较时过 规整表头（全角半角、括号里的说明、空格标点都不算）。
 * 同一个列名只认给先登记的字段，一个字段也只占一列——和大批导入的 猜列 同一个规矩。
 */
const 通用ID = ["记录ID", "ID", "编号", "数据ID", "唯一ID"];
export const 别名: Record<实体, Record<string, string[]>> = {
  customer: {
    id: ["客户ID", "客户编号", ...通用ID],
    name: ["客户名称", "公司名称", "企业名称", "客户名", "客户全称", "客户", "公司", "名称", "account name", "company"],
    phone: ["电话", "手机", "手机号", "手机号码", "联系电话", "公司电话", "座机", "联系方式", "phone", "mobile", "tel"],
    owner: ["负责人", "客户负责人", "归属人", "所属销售", "销售负责人", "销售", "拥有者", "owner"],
    followStatus: ["跟进状态", "客户状态"],
    remark: ["备注", "说明", "描述", "remark", "note"],
    email: ["邮箱", "电子邮箱", "email"],
    wechat: ["微信", "微信号"],
    whatsapp: ["whatsapp"],
    country: ["国家", "地区", "国家地区"],
    source: ["客户来源", "来源", "渠道"],
    level: ["客户等级", "等级", "级别"],
    website: ["网站", "官网", "网址"],
  },
  contact: {
    id: ["联系人ID", "联系人编号", ...通用ID],
    customerRef: ["客户ID", "所属客户ID", "客户编号"],
    customerName: ["客户名称", "所属客户", "关联客户", "公司名称", "客户", "公司"],
    name: ["联系人姓名", "姓名", "联系人", "名字"],
    position: ["职位", "职务", "岗位", "角色", "关系"],
    phone: ["手机", "电话", "手机号", "手机号码", "联系电话", "联系方式", "phone", "mobile"],
    email: ["邮箱", "电子邮箱", "email"],
    wechat: ["微信", "微信号"],
    isPrimary: ["关键联系人", "主联系人", "是否主联系人", "首要联系人"],
    remark: ["备注", "说明", "remark"],
  },
  lead: {
    id: ["线索ID", "线索编号", ...通用ID],
    name: ["线索名称", "公司名称", "企业名称", "客户名称", "公司", "名称"],
    contact: ["联系人", "联系人姓名", "姓名"],
    phone: ["手机", "电话", "手机号", "手机号码", "联系电话", "联系方式", "phone", "mobile"],
    email: ["邮箱", "电子邮箱", "email"],
    industry: ["行业", "所属行业"],
    source: ["线索来源", "来源", "渠道"],
    status: ["线索状态", "状态", "跟进状态"],
    owner: ["负责人", "线索负责人", "归属人", "销售", "owner"],
    remark: ["备注", "说明", "描述", "remark"],
  },
  opportunity: {
    id: ["商机ID", "商机编号", ...通用ID],
    customerRef: ["客户ID", "所属客户ID", "客户编号"],
    customerName: ["客户名称", "所属客户", "关联客户", "公司名称", "客户", "公司"],
    name: ["商机名称", "机会名称", "项目名称", "名称"],
    amount: ["商机金额", "预计成交金额", "预计金额", "销售金额", "金额"],
    stage: ["商机阶段", "销售阶段", "阶段"],
    status: ["商机状态", "状态", "赢单状态"],
    probability: ["赢率", "成交概率", "赢单率"],
    expectedDealAt: ["预计成交日期", "预计成交时间", "预计签约日期"],
    closedAt: ["成交日期", "赢单日期", "输单日期", "结单日期", "关闭日期", "签约日期"],
    owner: ["负责人", "商机负责人", "销售", "owner"],
    remark: ["备注", "说明", "描述", "remark"],
  },
  followup: {
    id: ["跟进ID", "跟进记录ID", ...通用ID],
    customerRef: ["客户ID", "所属客户ID", "客户编号"],
    customerName: ["客户名称", "所属客户", "关联客户", "公司名称", "客户", "公司"],
    opportunityRef: ["商机ID", "所属商机ID"],
    opportunityName: ["商机名称", "关联商机", "所属商机", "商机"],
    type: ["跟进方式", "跟进类型", "沟通方式", "方式", "类型"],
    title: ["标题", "主题"],
    content: ["跟进内容", "沟通内容", "跟进记录", "内容", "详情"],
    occurredAt: ["跟进时间", "跟进日期", "拜访时间", "时间", "日期", "创建时间"],
    owner: ["跟进人", "记录人", "负责人", "创建人"],
    status: ["状态"],
  },
};

/**
 * 原系统自带的「系统列」：落不到我们任何字段，拼进备注也只是噪音。规则认不出的其余列默认拼进备注。
 * 注意跟进的「创建时间」「创建人」在上面别名表里先被认走了，轮不到这里。
 */
const 系统列 = ["创建时间", "更新时间", "修改时间", "最后修改时间", "最后修改人", "修改人", "创建人", "最近跟进时间", "最后跟进时间", "最近跟进", "最后跟进", "所属部门", "数据来源", "锁定状态", "审批状态"].map(规整表头);

export function 是系统列(表头: string): boolean {
  return 系统列.includes(规整表头(表头));
}

/** 规则猜一类的列：认得出的落字段；认不出的系统列不用，其余拼进备注 */
export function 规则猜列(e: 实体, 表头: readonly string[]): 列映射 {
  const 索引 = new Map<string, string>();
  for (const [字段, 叫法] of Object.entries(别名[e])) {
    for (const a of 叫法) {
      const k = 规整表头(a);
      if (k && !索引.has(k)) 索引.set(k, 字段);
    }
  }
  const 用掉 = new Set<string>();
  const 列: 列映射 = {};
  for (const h of 表头) {
    const hit = 索引.get(规整表头(h));
    if (hit && !用掉.has(hit)) {
      用掉.add(hit);
      列[h] = hit;
    } else 列[h] = 是系统列(h) ? "" : 进备注;
  }
  return 列;
}

/** 每种值对照：从哪一类的哪个字段收原值、合法值有哪些 */
export const 值对照: Record<值对照名, { 实体: 实体; 字段: string; 叫法: string }> = {
  阶段: { 实体: "opportunity", 字段: "stage", 叫法: "商机阶段" },
  线索状态: { 实体: "lead", 字段: "status", 叫法: "线索状态" },
  跟进类型: { 实体: "followup", 字段: "type", 叫法: "跟进方式" },
  跟进状态: { 实体: "customer", 字段: "followStatus", 叫法: "客户跟进状态" },
};

export function 合法值(名: 值对照名): string[] {
  switch (名) {
    case "阶段":
      return [...OPP_STAGES, 输单];
    case "线索状态":
      return [...LEAD_STATUSES];
    case "跟进类型":
      return FOLLOW_TYPES.map((t) => t.value);
    case "跟进状态":
      return [...FOLLOW_STATUSES];
  }
}

/** 合法值 → 给人 / 给 AI 看的说法（跟进类型存的是英文） */
export function 值说法(名: 值对照名, v: string): string {
  if (名 === "跟进类型") return FOLLOW_TYPES.find((t) => t.value === v)?.label ?? v;
  return v;
}

/** 同义词：原值里含这些词就认成这个值。顺序要紧——「未成交」先认输单，「已转化」不能被「跟进」抢走 */
const 同义词: Record<值对照名, [string, RegExp][]> = {
  阶段: [
    [输单, /输单|丢单|未成交|失败|流失|关闭|lost|closed\s*lost/i],
    ["赢单成交", /赢单|成交|签约|签单|won|closed\s*won/i],
    ["谈判审核", /谈判|商务|审核|审批|合同|negotiat/i],
    ["方案报价", /方案|报价|投标|proposal|quot/i],
    ["需求确认", /需求|调研|评估|qualif/i],
    ["初步沟通", /初步|初次|接触|意向|发现|新建|prospect|initial/i],
  ],
  线索状态: [
    ["已转化", /转化|转客户|已转|convert/i],
    ["已放弃", /放弃|无效|作废|关闭|丢弃|废弃|invalid|closed/i],
    ["跟进中", /跟进中|处理中|联系中|沟通中|working|contacted/i],
    ["待跟进", /待跟进|未跟进|未处理|新建|新线索|待分配|new|open/i],
  ],
  跟进类型: [
    ["WHATSAPP", /whatsapp/i],
    ["WECHAT", /微信|wechat|企微/i],
    ["SMS", /短信|sms/i],
    ["EMAIL", /邮件|邮箱|email|mail/i],
    ["VISIT", /拜访|上门|面谈|面访|visit/i],
    ["MEETING", /会议|视频|线上|腾讯会议|飞书会议|meeting/i],
    ["PHONE", /电话|通话|致电|来电|call|phone/i],
    ["TASK", /任务|task/i],
    ["REMIND", /提醒|remind/i],
  ],
  跟进状态: [
    ["已流失", /流失|丢失|无效|放弃|输单/],
    ["已签约", /签约|成交|合作中|已合作|赢单/],
    ["暂缓跟进", /暂缓|搁置|暂停|冷冻/],
    ["意向较高", /意向|重点|高潜/],
    ["已加微信", /加微信|已加好友/],
    ["跟进中", /跟进中|联系中|沟通中/],
    ["待跟进", /待跟进|未跟进|新客户|新建/],
  ],
};

/** 规则认一个值：先认原样（含业务里改过的显示名），再认同义词。认不出返回 "" */
export function 规则对值(名: 值对照名, 原值: string, b?: 业务): string {
  const s = 原值.trim();
  if (!s) return "";
  if (名 === "阶段") {
    const v = 阶段值(b, s);
    if ((OPP_STAGES as readonly string[]).includes(v)) return v;
  } else if (名 === "跟进类型") {
    const t = FOLLOW_TYPES.find((x) => x.value === s.toUpperCase() || x.label === s);
    if (t) return t.value;
  } else {
    const hit = 认枚举(s, 合法值(名), 名 === "跟进状态" ? b?.statusLabels : undefined);
    if (hit) return hit;
  }
  for (const [v, re] of 同义词[名]) if (re.test(s)) return v;
  return "";
}

export type 成员 = { id: string; name: string; email: string | null };

/** 负责人写法里去掉括号里的部门 / 工号：「张三（销售一部）」→「张三」 */
function 去括号(s: string): string {
  return s.replace(/[(（[【][^)）\]】]*[)）\]】]/g, "").trim();
}

/** 规则认人：带 @ 的按邮箱，其余按名字；只认唯一命中的，重名不替人挑。认不出返回 "" */
export function 规则对负责人(写法: string, 候选: readonly 成员[]): string {
  const s = 去括号(写法.trim());
  if (!s) return "";
  const 中 = s.includes("@")
    ? 候选.filter((u) => u.email && u.email.toLowerCase() === s.toLowerCase())
    : 候选.filter((u) => u.name.trim() === s);
  return 中.length === 1 ? 中[0].id : "";
}

/** 从原始记录里收：每种值对照的原值、所有负责人写法。按出现次数从多到少 */
export function 收集原值(记录: readonly 原始记录[], 列: 映射["列"]): { 值: Record<值对照名, string[]>; 负责人: string[] } {
  const 数 = (m: Map<string, number>, v: string) => {
    const s = v.trim();
    if (s) m.set(s, (m.get(s) ?? 0) + 1);
  };
  const 值表 = Object.fromEntries((Object.keys(值对照) as 值对照名[]).map((k) => [k, new Map<string, number>()])) as Record<值对照名, Map<string, number>>;
  const 人 = new Map<string, number>();
  for (const r of 记录) {
    const m = 列[r.实体] ?? {};
    for (const [h, v] of Object.entries(r.字段)) {
      const std = m[h];
      if (!std) continue;
      if (std === "owner") 数(人, v);
      for (const [k, c] of Object.entries(值对照) as [值对照名, (typeof 值对照)[值对照名]][]) {
        if (c.实体 === r.实体 && c.字段 === std) 数(值表[k], v);
      }
    }
  }
  const 排 = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  return {
    值: Object.fromEntries(Object.entries(值表).map(([k, m]) => [k, 排(m)])) as Record<值对照名, string[]>,
    负责人: 排(人),
  };
}

/* ───────────────────────── AI 这一步 ───────────────────────── */

/** 一格样例打码：6 位以上的数字只留头 3 尾 2，邮箱只留域名，长文本截到 24 个字 */
export function 打码(v: string): string {
  let s = v.trim().replace(/\s+/g, " ");
  s = s.replace(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "***@$1");
  s = s.replace(/\d{6,}/g, (d) => `${d.slice(0, 3)}${"*".repeat(d.length - 5)}${d.slice(-2)}`);
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}

export type AI输入 = {
  /** 规则没认出来的列：每类给列名 + 最多 3 格打过码的样例 */
  列: Partial<Record<实体, { 表头: string; 样例: string[] }[]>>;
  /** 每类还空着、可以落的字段：标准字段 → 中文名 */
  可选字段: Partial<Record<实体, Record<string, string>>>;
  /** 规则没认出来的值 */
  值: Partial<Record<值对照名, { 原值: string[]; 可选: string[] }>>;
  /** 规则没认出来的负责人写法，和成员名单（只给名字） */
  负责人: { 原写法: string[]; 成员: string[] };
};

/** AI 的回答：列名 → 标准字段，原值 → 我们的值，原写法 → 成员名字。都是建议，回来还要校验 */
export type AI输出 = {
  列?: Partial<Record<实体, Record<string, string>>>;
  值?: Partial<Record<值对照名, Record<string, string>>>;
  负责人?: Record<string, string>;
};

export type 建议器 = (输入: AI输入) => Promise<AI输出>;

/** 每次最多问多少：值、写法太多时只问出现最多的那些，剩下的人在报告里自己对 */
const 每项上限 = 60;

const 提示词 = `你在帮一家公司把老 CRM（飞书 / 钉钉等）导出的数据搬进新 CRM。规则已经认出了大部分，下面是规则没认出来的几样，请逐项给建议。
输入是 JSON：
- 列：每类数据里没认出来的列名和几格样例（打过码）。从「可选字段」里给每列挑一个最贴切的字段；不确定就不要写这一列。
- 值：原系统里的阶段 / 状态 / 跟进方式写法，从「可选」里挑一个意思相同的；不确定就不要写。阶段里「输单」表示丢单、失败。
- 负责人：原系统里的负责人写法，从「成员」里挑同一个人（拼音、英文名、简称都可能）；不确定就不要写，绝不猜。
只回 JSON：{"列":{"customer":{"原列名":"字段"}},"值":{"阶段":{"原值":"可选值"}},"负责人":{"原写法":"成员名字"}}。没有建议的部分给空对象。`;

/** 真调 AI（客户自己的 Key）。没配 Key 的情况调用方已经挡掉了 */
export const AI建议: 建议器 = async (输入) => {
  const { chatMessagesJSON } = await import("../llm");
  const out = await chatMessagesJSON(
    [
      { role: "system", content: 提示词 },
      { role: "user", content: JSON.stringify(输入) },
    ],
    { maxTokens: 4000, temperature: 0, timeoutMs: 90_000, feature: "import" },
  );
  return (out && typeof out === "object" ? out : {}) as AI输出;
};

/**
 * 模拟模式（ENT_IMPORT_AI=mock）：不联网、不花钱，用来走通「问 AI → 校验 → 落进映射」这条路。
 * 列名里含某个可选字段的中文名就认它；值里含某个可选值的说法就认它；人一个都不认（真 AI 才敢认人）
 */
export const 模拟建议: 建议器 = async (输入) => {
  const 列: AI输出["列"] = {};
  for (const [e, cols] of Object.entries(输入.列) as [实体, { 表头: string }[]][]) {
    const 可选 = 输入.可选字段[e] ?? {};
    for (const c of cols) {
      const hit = Object.entries(可选).find(([, 中]) => 中.split(/\s*\/\s*/).some((w) => c.表头.includes(w)));
      if (hit) (列[e] ??= {})[c.表头] = hit[0];
    }
  }
  const 值: AI输出["值"] = {};
  for (const [k, x] of Object.entries(输入.值) as [值对照名, { 原值: string[]; 可选: string[] }][]) {
    for (const v of x.原值) {
      const hit = x.可选.find((o) => v.includes(o) || o.includes(v));
      if (hit) (值[k] ??= {})[v] = hit;
    }
  }
  return { 列, 值, 负责人: {} };
};

/** 该用哪个建议器：传了就用传的；ENT_IMPORT_AI=mock 用模拟；=off 不用；否则看有没有配 Key */
export async function 选建议器(传入?: 建议器 | null): Promise<{ 建议器: 建议器 | null; 说明: string }> {
  if (传入 !== undefined) return { 建议器: 传入, 说明: 传入 ? "" : "没用 AI，只按规则认" };
  const 开关 = process.env.ENT_IMPORT_AI;
  if (开关 === "mock") return { 建议器: 模拟建议, 说明: "AI 模拟模式（测试用，没真的调用）" };
  if (开关 === "off") return { 建议器: null, 说明: "AI 已关，只按规则认" };
  const { getLlmConfig } = await import("../llm-config");
  if (!(await getLlmConfig())) return { 建议器: null, 说明: "还没配 AI Key，只按规则认；规则认不出的在报告里手动对" };
  return { 建议器: AI建议, 说明: "" };
}

/* ───────────────────────── 合起来 ───────────────────────── */

export type 表概要 = { 实体: 实体; 表头: string[]; 行: string[][] };

export type 猜映射参数 = {
  表: 表概要[];
  记录: 原始记录[];
  候选: 成员[];
  默认负责人Id: string;
  业务?: 业务;
  /** 不传 = 按环境和 Key 自己选；null = 不用 AI */
  建议器?: 建议器 | null;
  /** 在已有的映射上补（重新试跑时人改过的不动） */
  已有?: 映射 | null;
  /** 已有映射里 AI 认的也不动（改映射重新试跑：不再问一次 AI，上次 AI 认的照留） */
  留AI?: boolean;
};

export type 猜映射结果 = { 映射: 映射; 提醒: string[] };

function 空映射(默认负责人Id: string): 映射 {
  return { 列: {}, 负责人: {}, 值: { 阶段: {}, 线索状态: {}, 跟进类型: {}, 跟进状态: {} }, 默认负责人Id, 说明: {} };
}

/** 说明的键：报告里按它显示「规则 / AI / 手动」 */
export const 说明键 = {
  列: (e: 实体, h: string) => `列|${e}|${h}`,
  值: (k: 值对照名, v: string) => `值|${k}|${v}`,
  人: (w: string) => `人|${w}`,
};

export async function 猜映射(p: 猜映射参数): Promise<猜映射结果> {
  const m = p.已有 ? structuredClone(p.已有) : 空映射(p.默认负责人Id);
  m.说明 ??= {};
  if (!m.默认负责人Id) m.默认负责人Id = p.默认负责人Id;
  const 提醒: string[] = [];
  // 人定过的（重新试跑时还有上次 AI 认的）不再动，也不再问
  const 手动 = (k: string) => m.说明![k] === "手动" || (!!p.留AI && m.说明![k] === "AI");

  // 1) 列：规则先猜；人手动定过的不动
  const 待问列: AI输入["列"] = {};
  const 可选字段: AI输入["可选字段"] = {};
  for (const t of p.表) {
    const 规则 = 规则猜列(t.实体, t.表头);
    const 列 = (m.列[t.实体] ??= {});
    for (const h of t.表头) {
      if (h in 列 && 手动(说明键.列(t.实体, h))) continue;
      列[h] = 规则[h];
      m.说明[说明键.列(t.实体, h)] = "规则";
    }
    const 占了 = new Set(Object.values(列).filter((v) => v && v !== 进备注));
    const 空字段 = 标准字段[t.实体].filter((f) => !占了.has(f));
    const 不认识 = t.表头.filter((h) => 列[h] === 进备注 && !手动(说明键.列(t.实体, h)));
    if (不认识.length && 空字段.length) {
      待问列[t.实体] = 不认识.map((h) => {
        const j = t.表头.indexOf(h);
        const 样例 = [...new Set(t.行.map((r) => r[j] ?? "").filter(Boolean))].slice(0, 3).map(打码);
        return { 表头: h, 样例 };
      });
      可选字段[t.实体] = Object.fromEntries(空字段.map((f) => [f, 字段中文[f] ?? f]));
    }
  }

  // 2) 值和负责人：先按列映射把原值收齐，规则认；认不出的留给 AI
  const 原 = 收集原值(p.记录, m.列);
  const 待问值: AI输入["值"] = {};
  for (const k of Object.keys(值对照) as 值对照名[]) {
    const 认不出: string[] = [];
    for (const v of 原.值[k]) {
      if (手动(说明键.值(k, v))) continue;
      const hit = 规则对值(k, v, p.业务);
      m.值[k][v] = hit;
      m.说明[说明键.值(k, v)] = "规则";
      if (!hit) 认不出.push(v);
    }
    if (认不出.length) 待问值[k] = { 原值: 认不出.slice(0, 每项上限), 可选: 合法值(k).map((v) => 值说法(k, v)) };
  }
  const 待问人: string[] = [];
  for (const w of 原.负责人) {
    if (手动(说明键.人(w))) continue;
    const id = 规则对负责人(w, p.候选);
    m.负责人[w] = id;
    m.说明[说明键.人(w)] = "规则";
    if (!id) 待问人.push(w);
  }

  // 3) 有没认出来的才问 AI
  const 有要问 = Object.keys(待问列).length || Object.keys(待问值).length || 待问人.length;
  if (有要问) {
    const 选 = await 选建议器(p.建议器);
    if (选.说明) 提醒.push(选.说明);
    if (选.建议器) {
      const 输入: AI输入 = {
        列: 待问列,
        可选字段,
        值: 待问值,
        负责人: { 原写法: 待问人.slice(0, 每项上限), 成员: [...new Set(p.候选.map((u) => u.name))] },
      };
      try {
        const out = await 选.建议器(输入);
        const n = 收AI建议(m, out, 输入, p.候选);
        if (n) 提醒.push(`AI 补认了 ${n} 项，报告里标了「AI」，请过一眼`);
      } catch (e) {
        提醒.push(`AI 这一步没成功（${e instanceof Error ? e.message.slice(0, 80) : "未知错误"}），先按规则认的；规则认不出的在报告里手动对`);
      }
    }
  }

  // 4) 必填字段没对上列的，直接告诉人
  for (const t of p.表) {
    const 列 = m.列[t.实体] ?? {};
    const 有 = new Set(Object.values(列));
    if (!有.has("name") && t.实体 !== "followup") 提醒.push(`${实体名[t.实体]}表没认出「名称」列，请在映射里指一列`);
    if (t.实体 === "followup" && !有.has("content") && !有.has("title")) 提醒.push("跟进记录表没认出「内容」列，请在映射里指一列");
    if (["contact", "opportunity", "followup"].includes(t.实体) && !有.has("customerRef") && !有.has("customerName")) {
      提醒.push(`${实体名[t.实体]}表没认出「所属客户」列，挂不到客户下面，请在映射里指一列`);
    }
  }
  return { 映射: m, 提醒 };
}

/** 把 AI 的回答校验后落进映射，返回落了几项。不合法的（字段不存在、被占了、值不在可选里、人不在名单里或重名）一律丢掉 */
export function 收AI建议(m: 映射, out: AI输出, 输入: AI输入, 候选: readonly 成员[]): number {
  let n = 0;
  m.说明 ??= {};
  for (const [e, cols] of Object.entries(out.列 ?? {}) as [实体, Record<string, string>][]) {
    const 问了 = new Set((输入.列[e] ?? []).map((c) => c.表头));
    const 可选 = 输入.可选字段[e] ?? {};
    const 列 = m.列[e];
    if (!列 || !cols || typeof cols !== "object") continue;
    for (const [h, f] of Object.entries(cols)) {
      if (!问了.has(h) || typeof f !== "string" || !(f in 可选)) continue;
      if (Object.values(列).includes(f)) continue; // 一个字段只占一列
      列[h] = f;
      m.说明[说明键.列(e, h)] = "AI";
      n++;
    }
  }
  for (const [k, vs] of Object.entries(out.值 ?? {}) as [值对照名, Record<string, string>][]) {
    const 问了 = new Set(输入.值[k]?.原值 ?? []);
    if (!m.值[k] || !vs || typeof vs !== "object") continue;
    for (const [v, 说] of Object.entries(vs)) {
      if (!问了.has(v) || typeof 说 !== "string") continue;
      const 合法 = 合法值(k).find((x) => x === 说 || 值说法(k, x) === 说);
      if (!合法) continue;
      m.值[k][v] = 合法;
      m.说明[说明键.值(k, v)] = "AI";
      n++;
    }
  }
  const 问了人 = new Set(输入.负责人.原写法);
  for (const [w, 名] of Object.entries(out.负责人 ?? {})) {
    if (!问了人.has(w) || typeof 名 !== "string") continue;
    const 中 = 候选.filter((u) => u.name === 名.trim());
    if (中.length !== 1) continue;
    m.负责人[w] = 中[0].id;
    m.说明[说明键.人(w)] = "AI";
    n++;
  }
  return n;
}
