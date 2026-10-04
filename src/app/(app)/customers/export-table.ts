/**
 * 客户列表「导出」的表头和每一行。从 CustomersView 的 exportCsv 里拆出来，是为了能单测「导出 → 再导入一圈」
 * （2026-10-04 J-073：原来 13 列、没有备注，人手录的备注导出全没了，组件内部函数测不到，就一直没人发现）。
 * 转义、BOM、公式注入防护在 lib/csv.ts 的 toCsv 里，这里只管写哪几列。
 */
import type { BusinessConfig } from "@/lib/business-config";
import { statusLabel } from "@/lib/business-config";
import { fmtDate } from "@/lib/utils";

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
};

/** 行上的签约按币种；老的调用方没给 signedTotals 时把 signedAmount 当人民币 */
export function 签约各币(r: { signedAmount: number; signedTotals?: { 币种: string; 合计: number }[] }) {
  return r.signedTotals ?? (r.signedAmount ? [{ 币种: "CNY", 合计: r.signedAmount }] : []);
}

export function 客户导出表(rows: 导出行[], b: BusinessConfig): { head: string[]; body: string[][] } {
  /*
    「备注」放最后一列，表头就叫「备注」：导入那边的别名认得它，导出的文件原样导回来备注落回备注栏，
    不会变成「某某：…」并进别处（2026-10-04 J-073）
  */
  const head = ["客户姓名", "联系电话", b.fields.school, b.fields.major, b.fields.grade, "推荐人", "渠道归属", "跟进状态", "决策状态", "预计签约", "签约金额", "销售负责人", "渠道负责人", "备注"];
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
