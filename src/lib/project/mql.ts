/**
 * 企业版 MQL 人工判定（2026-10-26 会定）：项目停在线索·线索验证时，人判一下这条线索合不合格。
 *   合格   → 往前推到 线索推进（照旧走 改节点：谁能推、有效沟通门槛、节点必填都一样拦）；
 *   不合格 → 退回 潜客培育，带一个培育跟进计划（下一步时间 + 客户上一条跟进计划），到日子再跟。
 * 不是企业版一律拦，一行不写。
 */
import { dayjs } from "../utils";
import { prisma } from "../prisma";
import { parseDateInput } from "../date-input";
import { 企业版 } from "@/lib/enterprise/switch";
import { 改节点 } from "./db";
import { 有效线索节点 } from "./stage-gates";

type 谁 = { id: string; role: string };

export const MQL合格去 = "线索推进";
export const MQL不合格去 = "潜客培育";

export async function 判MQL(
  me: 谁, projectId: string, 合格: boolean, 下一步时间?: string | null, now: Date = new Date(),
): Promise<({ ok: true; 自动推到?: string[] } | { ok: false; error: string })> {
  if (!企业版()) return { ok: false, error: "MQL 判定只在企业版有" };
  const p = await prisma.project.findUnique({ where: { id: String(projectId ?? "") }, select: { id: true, name: true, phase: true, node: true, result: true, customerId: true, ownerId: true } });
  if (!p) return { ok: false, error: "这个项目已经不在了，刷新看看" };
  if (p.result || p.phase !== "线索" || p.node !== 有效线索节点) return { ok: false, error: `只有停在「${有效线索节点}」的项目能判 MQL` };
  if (合格) return 改节点(me, p.id, { phase: "线索", node: MQL合格去 });
  const 日 = parseDateInput(下一步时间);
  if (!日) return { ok: false, error: "MQL 不合格要定下一次培育跟进的日期" };
  if (dayjs(日).format("YYYY-MM-DD") < dayjs(now).format("YYYY-MM-DD")) return { ok: false, error: "下一次培育跟进不能早于今天" };
  const r = await 改节点(me, p.id, { phase: "线索", node: MQL不合格去 });
  if (!r.ok) return r;
  await prisma.$transaction(async (tx) => {
    await tx.project.update({ where: { id: p.id }, data: { nextStepAt: 日 } });
    await tx.followPlan.create({
      data: {
        subject: `潜客培育：项目「${p.name}」MQL 不合格，按计划再跟进`,
        plannedAt: 日, plannedOn: dayjs(日).format("YYYY-MM-DD"), plannedHasTime: false,
        customerId: p.customerId, ownerId: p.ownerId,
      },
    });
  });
  return { ok: true };
}
