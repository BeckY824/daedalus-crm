/**
 * 从客户页点「背调」时背调谁（10-21 客户反馈）。
 *
 * 客户档案里「客户名」多半是人（ZEESHAN AFZAL），公司在「公司」那一栏（存在 Customer.school，
 * 显示名由业务配置的 fields.school 定）。以前直接拿客户名当公司查，查成了另一家、国家也错。现在：
 *   - 有公司 → 背调公司；客户名不一样的当「这家公司的联系人」带上，国家 / 官网 / 邮箱 / 电话当线索
 *   - 没公司有官网 → 背调官网那家
 *   - 都没有、有能认出的国际号码（WhatsApp 优先）→ 走「名字 + 电话找公司」（person.ts），和首页同一条路
 *   - 什么都没有 → 不开跑、不扣次数，告诉人先补哪样
 * 浏览器（按钮提示、开跑前写清在查谁）和服务器（stream.ts 以档案为准，不信浏览器传的公司名）都用这一份。
 */
import { 主机 } from "./verify/domain";

export type 客户档案 = {
  name: string;
  /** Customer.school：通用 / 外贸叫「公司」，用户能改名（「公司名称」…），照样当公司；只有教培模版的「院校」不当 */
  company?: string | null;
  country?: string | null;
  website?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
};

export type 背调对象 =
  | { 种类: "公司"; 公司: string; 联系人?: string; 国家?: string }
  | { 种类: "找人"; 名: string; 电话: string; 国家?: string }
  | { 种类: "不够"; 原因: string };

const 干净 = (v?: string | null) => (v ?? "").trim();
/** 像国际号码：+ 开头、至少 8 位数字。真认（哪国、虚构号段）在服务器 person.ts 认号码，这里不引 libphonenumber 进浏览器 */
const 像国际号码 = (p: string) => /^\+\d/.test(p) && p.replace(/\D/g, "").length >= 8;
const 同一个 = (a: string, b: string) => a.replace(/\s+/g, " ").toLowerCase() === b.replace(/\s+/g, " ").toLowerCase();

export function 客户背调对象(c: 客户档案, 公司栏名: string): 背调对象 {
  const 是公司栏 = 公司栏名.trim() !== "院校";
  const 名 = 干净(c.name);
  const 国家 = 干净(c.country) || undefined;
  const 公司 = 是公司栏 ? 干净(c.company) : "";
  const 官网 = 主机(干净(c.website))?.replace(/^www\./, "");
  const 主体 = 公司.length >= 2 ? 公司.slice(0, 120) : 官网;
  if (主体) return { 种类: "公司", 公司: 主体, ...(名 && !同一个(名, 主体) ? { 联系人: 名.slice(0, 80) } : {}), ...(国家 ? { 国家 } : {}) };
  const 号 = [c.whatsapp, c.phone].map(干净).find(像国际号码);
  if (号) return { 种类: "找人", 名: 名.slice(0, 80), 电话: 号, ...(国家 ? { 国家 } : {}) };
  return {
    种类: "不够",
    原因: `这位客户没填${是公司栏 ? `${公司栏名.trim() || "公司"}、` : ""}官网，也没有带国家码的电话 / WhatsApp（+ 开头），没法背调。先在档案里补一样，不扣次数`,
  };
}

/** 按钮提示、开跑那一下写的「在查谁」：背调 ISHA.A SAS（法国）· 联系人 ZEESHAN AFZAL */
export function 对象说明(o: 背调对象): string {
  if (o.种类 === "公司") return `背调 ${o.公司}${o.国家 ? `（${o.国家}）` : " "}${o.联系人 ? `· 联系人 ${o.联系人}` : ""}`.trim();
  if (o.种类 === "找人") return `没填公司：先按 ${o.名 ? `${o.名} 和 ` : ""}${o.电话} 找他在哪家公司，再背调那家`;
  return o.原因;
}
