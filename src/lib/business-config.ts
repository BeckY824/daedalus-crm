/**
 * 业务配置：这套 CRM **默认是通用销售措辞**（客户、公司/职位/行业），
 * 数据模型本来就是一条通用的销售漏斗。教培招生那套（学员、院校/年级/专业、试听）
 * 留成一个预设，一键套用——2026-09-18 之前默认是教培那套，反了。
 *
 * 措辞从这里读、不写死在代码里，所以换一套预设全站跟着变（界面、AI 提示词、导出）。
 *
 * 能改的：核心名词、三个档案字段的显示名、三组纯数据的选项列表、给 AI 的业务简介。
 * 不能改的：跟进状态与决策状态的**存储值**——盯盘权重、雷达、首页统计、终态判断都按值引用。
 *
 * 客户端组件通过 <BusinessProvider> 拿（见 business-client.tsx），服务端直接 await getBusiness()。
 */
import { GRADES, TITLES, CUSTOMER_SOURCES, INDUSTRIES, FOLLOW_STATUSES, DECISION_STATUSES } from "./constants";

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
    sources: [...CUSTOMER_SOURCES],
    industries: [...INDUSTRIES],
    // 教培场景下这三个值本来就说得通，不另起显示名
    statusLabels: {},
  },
};

export const PRESET_NAMES = Object.keys(BUSINESS_PRESETS);

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

export const BUSINESS_KEY = "business";

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
  };
}
