/**
 * 业务配置：这套 CRM **默认是通用销售措辞**（客户、公司/职位/行业），
 * 数据模型本来就是一条通用的销售漏斗。教培招生那套（学员、院校/年级/专业、试听）
 * 留成一个预设，一键套用——2026-09-18 之前默认是教培那套，反了。
 * 外贸出口是第三套：字段名和通用销售一样，差别在三组选项（询盘平台、展会、开发信）
 * 和几个状态的显示名（寄样、已建联）。
 *
 * 措辞从这里读、不写死在代码里，所以换一套预设全站跟着变（界面、AI 提示词、导出）。
 *
 * 能改的：核心名词、三个档案字段的显示名、三组纯数据的选项列表、给 AI 的业务简介。
 * 不能改的：跟进状态与决策状态的**存储值**——盯盘权重、雷达、首页统计、终态判断都按值引用。
 *
 * 客户端组件通过 <BusinessProvider> 拿（见 business-client.tsx），服务端直接 await getBusiness()。
 */
import {
  GRADES, TITLES, CUSTOMER_SOURCES, EDU_SOURCES, INDUSTRIES,
  TRADE_TITLES, TRADE_SOURCES, TRADE_INDUSTRIES,
  FOLLOW_STATUSES, DECISION_STATUSES,
} from "./constants";
import { 规整币种 } from "./currency";
import { 订单 } from "./features";

/**
 * 模版（2026-10-03）：新用户注册后选「通用」还是「外贸」。和预设是两回事——预设只是一组措辞，
 * 模版还决定**有哪些功能**：订单节点、供应商比价只在外贸模版下出现；本位币默认值也跟着它。
 * 教培招生那套措辞还在，但它算「通用」模版（用户：「我们应该只有通用模版，以及外贸模版」）。
 */
export type BusinessTemplate = "general" | "trade";
export const 模版名: Record<BusinessTemplate, string> = { general: "通用", trade: "外贸" };

export type BusinessConfig = {
  /** 一段话：卖什么、客户是谁、怎么成交。注入全部 AI 提示词 */
  brief: string;
  /** 核心名词：客户叫什么。默认「客户」 */
  customer: string;
  /** 三个档案字段的显示名。数据库列不动（school/grade/major） */
  fields: { school: string; grade: string; major: string };
  /** 三组选项列表 */
  grades: string[];
  sources: string[];
  industries: string[];
  /**
   * 跟进状态 / 决策状态的显示名：存储值 → 界面上叫什么。只存改过的那几个。
   * 存储值本身不能改——盯盘权重、雷达、首页统计、终态判断都按值引用。
   */
  statusLabels: Record<string, string>;
  /** 用的是哪个模版。见上面 BusinessTemplate */
  template: BusinessTemplate;
  /** 本位币：新建商机 / 签约时默认选它。通用 CNY、外贸 USD；见 lib/currency.ts */
  currency: string;
  /**
   * 公海：多少天没跟进就自动放进公海。0 = 不开（默认）。只在多人时有意义，随团队同步（整个 business 一份）。
   * 不是「措辞」，套用预设时不动它（见 BusinessSettingsTab）
   */
  poolDays: number;
};

export const DEFAULT_BUSINESS: BusinessConfig = {
  brief:
    "面向企业客户的销售团队。客户是公司和公司里的人，通过沟通、演示、报价推进到成交；" +
    "老客户转介绍是重要来源。沟通主要在微信和电话上进行。",
  customer: "客户",
  fields: { school: "公司", grade: "职位", major: "行业" },
  grades: [...TITLES],
  sources: [...CUSTOMER_SOURCES],
  industries: [...INDUSTRIES],
  /**
   * 三个状态值天生带教培味（值不能改——盯盘权重、终态判断、首页统计八处按值引用），
   * 默认给它们一个通用的显示名。存过业务配置的库以自己存的为准，见 mergeBusiness。
   */
  statusLabels: { 已试听: "已演示", 与家人商议: "内部讨论", 已决定报名: "已决定采购" },
  template: "general",
  currency: "CNY",
  poolDays: 0,
};

/**
 * 预设：把一整组措辞一次填好。**不是新的配置项**，是填表的快捷方式——
 * 套用之后每一项照样能自己改。
 */
export const BUSINESS_PRESETS: Record<string, BusinessConfig> = {
  通用销售: DEFAULT_BUSINESS,
  教培招生: {
    brief:
      "教育培训机构的招生团队。客户是学生及其家长，通过试听课、咨询沟通推进到报名签约；" +
      "很多新学员来自已报名学员的转介绍。沟通主要在微信和电话上进行。",
    customer: "学员",
    fields: { school: "院校", grade: "年级", major: "专业" },
    grades: [...GRADES],
    sources: [...EDU_SOURCES],
    industries: [...INDUSTRIES],
    // 教培场景下这三个值本来就说得通，不另起显示名
    statusLabels: {},
    template: "general",
    currency: "CNY",
    poolDays: 0,
  },
  外贸出口: {
    brief:
      "面向海外客户的外贸销售团队。客户是海外采购商、经销商和工程商，" +
      "通过询盘、报价、寄样、验厂推进到下单；展会和老客户返单是重要来源。" +
      "沟通主要在 WhatsApp、邮件和微信上进行。",
    customer: "客户",
    fields: { school: "公司", grade: "职位", major: "行业" },
    grades: [...TRADE_TITLES],
    sources: [...TRADE_SOURCES],
    industries: [...TRADE_INDUSTRIES],
    /*
      三个带教培味的状态值在外贸这条链上各有对应的一步：试听 → 寄样，
      与家人商议 → 客户内部讨论，决定报名 → 决定下单。「已加微信」对海外客户
      多半不是微信，改成中性的「已建联」。值本身不动，只改显示名。
    */
    // 已签约 → 已下单（2026-10-05）：外贸模版下签约就是订单，见 lib/order-contract.ts
    statusLabels: { 已加微信: "已建联", 已试听: "已寄样", 与家人商议: "内部讨论", 已决定报名: "已决定下单", 已签约: "已下单" },
    template: "trade",
    currency: "USD",
    poolDays: 0,
  },
};

/**
 * 新用户选模版时给的两个（教培不给新用户看，老用户在设置里还能看到——见 BusinessSettingsTab）。
 * 选了哪个就整组套哪个预设
 */
export const 模版预设: Record<BusinessTemplate, string> = { general: "通用销售", trade: "外贸出口" };

/**
 * 老库没存 template 时推断：来源选项里有外贸那组独有的（阿里国际站、展会…）就是外贸，其余都算通用。
 * 只看来源一项——外贸预设和通用的档案字段一模一样，分不出来
 */
export function 推断模版(p: Partial<BusinessConfig>): BusinessTemplate {
  const 外贸独有 = TRADE_SOURCES.filter((x) => !CUSTOMER_SOURCES.includes(x as never));
  return Array.isArray(p.sources) && p.sources.some((x) => 外贸独有.includes(x as never)) ? "trade" : "general";
}

/**
 * 「与客户关系」的候选（审查 M14）。原来写死成教培那组「母亲 / 父亲 / 学生本人 / 其他亲属」，
 * 通用销售和外贸的人添加联系人时占位符写着「母亲」，而他列表里填的全是「本人 / 助理 / 财务」。
 * 业务配置里不存「套的是哪个预设」，按档案字段 1 认：叫「院校」就是教培那套。
 * 只是候选，框里照样能自己填。
 */
export function 关系候选(b: Pick<BusinessConfig, "fields">): string[] {
  return b.fields.school === "院校" ? ["母亲", "父亲", "学生本人", "其他亲属"] : ["本人", "老板", "采购", "财务", "助理"];
}

/** 允许改显示名的状态值全集 */
export const RELABELABLE_STATUSES: readonly string[] = [...FOLLOW_STATUSES, ...DECISION_STATUSES];

/**
 * 状态值 → 显示名；没改过就是值本身。
 *
 * `statusLabels` 缺席也要能用：这个函数现在被系统提示词的取值表调用，
 * 而调用方手里未必是一份完整的配置（测试里、老的缓存里都可能只有半份）。
 * 少一张表不该让整个 agent 崩在拼提示词那一步。
 */
export function statusLabel(b: Pick<BusinessConfig, "statusLabels"> | null | undefined, value: string): string {
  const l = b?.statusLabels?.[value];
  return l && l.trim() ? l.trim() : value;
}

/**
 * 商机阶段的显示名（2026-10-03）。外贸模版下换成外贸的叫法，**存的值不动**（报表、漏斗、AI 的筛选都按值算）。
 * 不进设置、不让改：阶段是商机这一段流程本身，换一套叫法就够了，再开一组输入框只是让人多犹豫。
 * 依据：外贸CRM模版.md 6.4 第 1 项（询盘 → 比价 → 报价 → 寄样 → 客户确认，确认之后转订单）。
 */
export const 外贸阶段名: Record<string, string> = {
  初步沟通: "询盘",
  需求确认: "比价中",
  方案报价: "已报价",
  谈判审核: "寄样",
  赢单成交: "客户确认",
};

export function stageLabel(b: Pick<BusinessConfig, "template"> | null | undefined, value: string): string {
  return b?.template === "trade" ? (外贸阶段名[value] ?? value) : value;
}

/** 反过来：人（或 AI）说「询盘」时认出是哪个存储值。认不出原样返回 */
export function 阶段值(b: Pick<BusinessConfig, "template"> | null | undefined, 说法: string): string {
  if (b?.template !== "trade") return 说法;
  return Object.entries(外贸阶段名).find(([, l]) => l === 说法)?.[0] ?? 说法;
}

/**
 * 外贸模版下「签约」就是「订单」（2026-10-05 外贸客户建议：「把客户详情里面的签约名称改成订单」）。
 * 一笔签约同时是一张订单（lib/order-contract.ts），界面上叫订单、多出订单号 / 付款方式 / 供应商；
 * 存的还是签约，业绩、首页、数据页照签约算。订单开关关着（lib/features.ts）时一律照旧叫签约
 */
export function 外贸订单(b: Pick<BusinessConfig, "template"> | null | undefined): boolean {
  return b?.template === "trade" && 订单;
}

/** 「签约」这个词在这一套里叫什么 */
export function 签约叫(b: Pick<BusinessConfig, "template"> | null | undefined): "订单" | "签约" {
  return 外贸订单(b) ? "订单" : "签约";
}

/**
 * 外贸模版下不摆的东西（2026-10-05 外贸客户建议）：
 *   预计签约（「没有意义」——外贸的采购时间跟着每一次询盘走，见商机的询盘时间）、
 *   推荐人 / 渠道归属 / 渠道负责人 / 左栏渠道（推荐分佣链是教培那一套）、商机的成交概率。
 * 数据都留着，只是不摆；切回通用模版全都回来
 */
export function 外贸精简(b: Pick<BusinessConfig, "template"> | null | undefined): boolean {
  return b?.template === "trade";
}

export const BUSINESS_KEY = "business";

/** 公海天数规整成 0 或 1–365 的整数；乱填的、负的都当不开 */
export function 公海天数(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 365) : 0;
}

/**
 * 设置 → 业务配置保存时要存的公海天数（2026-10-04 T-044，从 BusinessSettingsTab 挪出来好测）：
 *   - 摆着这一项（多人）时**清空 = 0 = 不开**：InputNumber 清空交上来是 null，要是退回原值，人以为关了、自动扫公海照扫，
 *     客户被成批挪进公海、负责人看起来被换掉了
 *   - 没摆（一个人用，表单里没有这一项）时照原值存回去，别悄悄关掉
 */
export function 表单公海天数(填的: number | null | undefined, 摆着: boolean, 原值: number): number {
  return 摆着 ? 公海天数(填的 ?? 0) : 原值;
}

/**
 * 与默认值合并：某一项没存过或存坏了，就用默认，页面不会因为一项缺失而空白。
 *
 * **显示名那一项不走这条规矩**：没存过业务配置的库（新装的）用默认那三个通用显示名；
 * 存过的以他自己存的为准，包括「一个都没改」。否则人在界面上把「已演示」清空、
 * 想看回原值「已试听」，保存完默认值又把它塞回来——那就成了一个改不掉的字段。
 */
export function mergeBusiness(partial: Partial<BusinessConfig> | null | undefined): BusinessConfig {
  const 存过 = partial != null;
  const p = partial ?? {};
  const list = (v: unknown, d: string[]) =>
    Array.isArray(v) && v.length > 0 ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : d;
  const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() !== "" ? v.trim() : d);
  // 只留合法状态值、且确实改了名的项；与值相同的显示名不存，免得以后改值时被它"钉住"
  const labels = (v: unknown): Record<string, string> => {
    if (!v || typeof v !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (!RELABELABLE_STATUSES.includes(k) || typeof val !== "string") continue;
      const t = val.trim();
      if (t && t !== k) out[k] = t;
    }
    return out;
  };
  return {
    brief: str(p.brief, DEFAULT_BUSINESS.brief),
    customer: str(p.customer, DEFAULT_BUSINESS.customer),
    fields: {
      school: str(p.fields?.school, DEFAULT_BUSINESS.fields.school),
      grade: str(p.fields?.grade, DEFAULT_BUSINESS.fields.grade),
      major: str(p.fields?.major, DEFAULT_BUSINESS.fields.major),
    },
    grades: list(p.grades, DEFAULT_BUSINESS.grades),
    sources: list(p.sources, DEFAULT_BUSINESS.sources),
    industries: list(p.industries, DEFAULT_BUSINESS.industries),
    statusLabels: 存过 ? labels(p.statusLabels) : { ...DEFAULT_BUSINESS.statusLabels },
    template: p.template === "general" || p.template === "trade" ? p.template : 推断模版(p),
    currency: 规整币种(p.currency, (p.template === "trade" || (p.template == null && 推断模版(p) === "trade")) ? "USD" : "CNY"),
    poolDays: 公海天数(p.poolDays),
  };
}
