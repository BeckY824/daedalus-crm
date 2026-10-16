/**
 * 同步相关清单（待核对、被同事盖掉的改动）给人看的叫法：表名、列名用中文，时间戳那几列不提（2026-10-16 团队版全面检验）。
 */
import { CUSTOMER_FIELD_LABELS } from "../concurrency";

const 表名: Record<string, string> = { Customer: "客户", CustomerExtra: "客户档案", Contact: "联系人", FollowUp: "跟进", Opportunity: "商机", Contract: "签约", Task: "任务", FollowPlan: "跟进计划", Lead: "线索", UnassignedContact: "待归属联系人", TradeOrder: "外贸订单" };
/** 列的叫法：原来直接摆库里的列名（「remark、updatedAt」），业务员看不懂改的是什么（2026-10-16 团队版全面检验） */
const 通用列名: Record<string, string> = {
  name: "名称", phone: "电话", email: "邮箱", wechat: "微信", remark: "备注", title: "标题", content: "内容", type: "类型", status: "状态",
  subject: "主题", plannedAt: "计划时间", plannedOn: "计划日期", method: "方式", done: "完成", doneAt: "完成时间", occurredAt: "发生时间",
  dueAt: "截止时间", dueOn: "截止日期", amount: "金额", stage: "阶段", probability: "赢率", expectedDealAt: "预计成交", position: "职位",
  isPrimary: "主联系人", ownerId: "负责人", customerId: "所属客户", contactId: "联系人", opportunityId: "商机", duration: "时长", participants: "参与人",
  country: "国家 / 地区", whatsapp: "WhatsApp", source: "来源",
};
/** 每一行都会带着变的时间戳，不算人改的 */
const 不提的列 = new Set(["updatedAt", "createdAt", "activityAt", "plannedHasTime", "dueHasTime"]);
export const 表的叫法 = (tbl: string) => 表名[tbl] ?? tbl;
export function 列的叫法(tbl: string, cols: string[]): string[] {
  const 叫 = (c: string) => (tbl === "Customer" ? CUSTOMER_FIELD_LABELS[c] : undefined) ?? 通用列名[c] ?? c;
  const out = [...new Set(cols.filter((c) => !不提的列.has(c)).map(叫))];
  return out.length ? out : cols.map(叫);
}
