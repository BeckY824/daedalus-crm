/**
 * AI 用量：每次真的调了模型就记一条操作日志（action=ai_use，entityId=功能键）。
 * 设置页据此汇总本月各功能用了多少次——没有单独的计数表，日志本来就只增不删，
 * 少一张表就少一处会和真实情况对不上的地方。
 */
import { prisma } from "./prisma";
import { recordAudit, type Actor } from "./audit";

export const AI_FEATURES = {
  parse: "跟进速记",
  brief: "临战简报",
  ask: "问数据",
  wakeup: "盯盘话术",
  invite: "转介绍邀请",
} as const;
export type AiFeature = keyof typeof AI_FEATURES;

export async function recordAiUse(user: Actor, feature: AiFeature, summary: string, entityId?: string | null) {
  await recordAudit({ user, action: "ai_use", entity: "Ai", entityId: feature, summary, detail: entityId ? { 对象: entityId } : undefined });
}

export type AiUsage = { feature: AiFeature; label: string; count: number }[];

/** 本月（自然月）各功能的调用次数，含 0 的项，按功能固定顺序 */
export async function aiUsageThisMonth(now = new Date()): Promise<AiUsage> {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const rows = await prisma.auditLog.groupBy({
    by: ["entityId"],
    where: { action: "ai_use", at: { gte: start } },
    _count: { _all: true },
  });
  const map = new Map(rows.map((r) => [r.entityId, r._count._all]));
  return (Object.keys(AI_FEATURES) as AiFeature[]).map((f) => ({ feature: f, label: AI_FEATURES[f], count: map.get(f) ?? 0 }));
}
