/**
 * 业务配置：这套 CRM 默认按教培招生场景措辞（学员、院校/年级/专业、试听……），
 * 但数据模型其实是通用的销售漏斗。一个工作室把「学员」叫成「客户」、
 * 「院校/年级/专业」叫成「公司/类型/行业」就能用——所以措辞从这里读，不写死在代码里。
 *
 * 能改的：核心名词、三个档案字段的显示名、三组纯数据的选项列表、给 AI 的业务简介。
 * 不能改的：跟进状态与决策状态的**存储值**——盯盘权重、雷达、首页统计、终态判断都按值引用。
 *
 * 客户端组件通过 <BusinessProvider> 拿（见 business-client.tsx），服务端直接 await getBusiness()。
 */
import { GRADES, CUSTOMER_SOURCES, INDUSTRIES } from "./constants";

export type BusinessConfig = {
  /** 一段话：卖什么、客户是谁、怎么成交。注入全部 AI 提示词 */
  brief: string;
  /** 核心名词：客户叫什么。默认「学员」 */
  customer: string;
  /** 三个档案字段的显示名。数据库列不动 */
  fields: { school: string; grade: string; major: string };
  /** 三组选项列表 */
  grades: string[];
  sources: string[];
  industries: string[];
};

export const DEFAULT_BUSINESS: BusinessConfig = {
  brief:
    "教育培训机构的招生团队。客户是学生及其家长，通过试听课、咨询沟通推进到报名签约；" +
    "很多新学员来自已报名学员的转介绍。沟通主要在微信和电话上进行。",
  customer: "学员",
  fields: { school: "院校", grade: "年级", major: "专业" },
  grades: [...GRADES],
  sources: [...CUSTOMER_SOURCES],
  industries: [...INDUSTRIES],
};

export const BUSINESS_KEY = "business";

/** 与默认值合并：某一项没存过或存坏了，就用默认，页面不会因为一项缺失而空白 */
export function mergeBusiness(partial: Partial<BusinessConfig> | null | undefined): BusinessConfig {
  const p = partial ?? {};
  const list = (v: unknown, d: string[]) =>
    Array.isArray(v) && v.length > 0 ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : d;
  const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() !== "" ? v.trim() : d);
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
  };
}
