/**
 * 客户列表「导出」的表头和每一行。从 CustomersView 的 exportCsv 里拆出来，是为了能单测「导出 → 再导入一圈」
 * （2026-10-04 J-073：原来 13 列、没有备注，人手录的备注导出全没了，组件内部函数测不到，就一直没人发现）。
 * 转义、BOM、公式注入防护在 lib/csv.ts 的 toCsv 里，这里只管写哪几列。
 */
import type { BusinessConfig } from "@/lib/business-config";
import { statusLabel, 外贸精简, 签约叫 } from "@/lib/business-config";
import { fmtDate, fmtDateTime } from "@/lib/utils";
import { FOLLOW_TYPE_MAP } from "@/lib/constants";
import type { 外贸档案 } from "@/lib/customer-extra";

/** 导出要用到的那几样。CustomerRow（列表行）和 客户行（导出取数）都满足 */
export type 导出行 = {
  name: string;
  phone: string;
  school: string | null;
  major: string | null;
  grade: string | null;
  referrerName?: string | null;
  attributionName?: string | null;
  followStatus: string;
  decisionStatus: string;
  expectedSignAt: string | null;
  signedAmount: number;
  signedTotals?: { 币种: string; 合计: number }[];
  salesOwnerName: string;
  channelOwnerName?: string | null;
  remark: string | null;
  /** 外贸档案（2026-10-05）。外贸模版导出时写成五列 */
  extra?: 外贸档案 | null;
};

/** 行上的签约按币种；老的调用方没给 signedTotals 时把 signedAmount 当人民币 */
export function 签约各币(r: { signedAmount: number; signedTotals?: { 币种: string; 合计: number }[] }) {
  return r.signedTotals ?? (r.signedAmount ? [{ 币种: "CNY", 合计: r.signedAmount }] : []);
}

export function 客户导出表(rows: 导出行[], b: BusinessConfig): { head: string[]; body: string[][] } {
  /*
    外贸模版（2026-10-05）：多国家 / WhatsApp / 微信 / 邮箱 / 来源五列，不写推荐人、渠道归属、渠道负责人、预计签约
    （界面上不摆的，导出也不写）。表头和导入认的别名一致（lib/import/fields.ts），导回来各落各的格
  */
  if (外贸精简(b)) {
    const 金额 = (r: 导出行) => 签约各币(r).filter((x) => x.合计 > 0).map((x) => `${x.币种} ${x.合计}`).join(" · ");
    return {
      head: [`${b.customer}姓名`, "联系电话", b.fields.school, b.fields.major, b.fields.grade, "国家", "WhatsApp", "微信", "邮箱", "来源", "跟进状态", "决策状态", `${签约叫(b)}金额`, "销售负责人", "备注"],
      body: rows.map((r) => [
        r.name, r.phone, r.school ?? "", r.major ?? "", r.grade ?? "",
        r.extra?.country ?? "", r.extra?.whatsapp ?? "", r.extra?.wechat ?? "", r.extra?.email ?? "", r.extra?.source ?? "",
        statusLabel(b, r.followStatus), statusLabel(b, r.decisionStatus), 金额(r), r.salesOwnerName, r.remark ?? "",
      ]),
    };
  }
  /*
    「备注」放最后一列，表头就叫「备注」：导入那边的别名认得它，导出的文件原样导回来备注落回备注栏，
    不会变成「某某：…」并进别处（2026-10-04 J-073）
  */
  // 姓名那一列跟叫法走（L-057：叫「学员」的库导出来还写「客户姓名」）；导入的别名认 `${b.customer}姓名`，导回来照样认得
  const head = [`${b.customer}姓名`, "联系电话", b.fields.school, b.fields.major, b.fields.grade, "推荐人", "渠道归属", "跟进状态", "决策状态", "预计签约", "签约金额", "销售负责人", "渠道负责人", "备注"];
  const body = rows.map((r) => [
    r.name, r.phone, r.school ?? "", r.major ?? "", r.grade ?? "",
    r.referrerName ?? "", r.attributionName ?? "", statusLabel(b, r.followStatus), statusLabel(b, r.decisionStatus),
    // 导出写「USD 3,200 · CNY 19,800」：只写数字的话，美元单在表里就成了人民币
    r.expectedSignAt ? fmtDate(r.expectedSignAt) : "", 签约各币(r).filter((x) => x.合计 > 0).map((x) => `${x.币种} ${x.合计}`).join(" · "),
    r.salesOwnerName, r.channelOwnerName ?? "",
    r.remark ?? "",
  ]);
  return { head, body };
}

/** 导出时一条跟进要的那几样（export-action.ts 取） */
export type 跟进导出行 = {
  customerName: string;
  phone: string;
  occurredAt: string;
  type: string;
  title: string;
  content: string;
  status: string;
  opportunityName: string | null;
  orderNo: string | null;
  ownerName: string;
};

/**
 * 「跟进记录」那张表（2026-10-05 外贸客户：「导出客户的时候，是否也能把跟进的记录也一并导出」）。
 * 一条跟进一行，按客户、再按时间先后排，带上客户姓名和电话——在 Excel 里按客户筛就是这位的全部往来
 */
export function 跟进导出表(rows: 跟进导出行[], b: BusinessConfig): { head: string[]; body: string[][] } {
  const 挂 = 签约叫(b) === "订单" ? "关联商机 / 订单" : "关联商机";
  return {
    head: [`${b.customer}姓名`, "联系电话", "时间", "方式", "标题", "内容", "状态", 挂, "记录人"],
    body: rows.map((f) => [
      f.customerName, f.phone, fmtDateTime(f.occurredAt), FOLLOW_TYPE_MAP[f.type]?.label ?? f.type, f.title, f.content, f.status,
      f.orderNo ? `订单 ${f.orderNo}` : f.opportunityName ?? "", f.ownerName,
    ]),
  };
}
