/**
 * 企业版沟通记录编号（2026-10-26）：项目上的每条沟通记一个 FUL + yyyyMMdd + 6 位当天流水，和这条的下一步时间
 * （时限提醒按它算，见 blocker-rules.ts 时限提醒of）。项目上记沟通、建档向导的首条跟进都走这里。
 * 只用传进来的 tx；不是企业版什么都不写
 */
import type { Prisma } from "@/generated/prisma";
import { prisma } from "../prisma";
import { 企业版 } from "@/lib/enterprise/switch";
import { 沟通编号前缀, 拼编号, 编号日, 下一个流水 } from "./blocker-rules";

export async function 记沟通编号(
  tx: Prisma.TransactionClient,
  followUpId: string,
  projectId: string,
  nextAt: Date | null,
  now: Date = new Date(),
): Promise<string | null> {
  if (!企业版()) return null;
  const 头 = `${沟通编号前缀}${编号日(now)}`;
  // 当天最大号得全库找：走模型查询会被团队范围限定（组员看不到别人的项目），撞号。原生查询不过范围
  const 最大 = await tx.$queryRaw<{ code: string }[]>`SELECT "code" FROM "EntFollowUpMeta" WHERE "code" LIKE ${`${头}%`} ORDER BY "code" DESC LIMIT 1`;
  const code = 拼编号(沟通编号前缀, now, 下一个流水(最大[0]?.code, 沟通编号前缀, now), 6);
  await tx.entFollowUpMeta.create({ data: { followUpId, projectId, code, nextAt } });
  return code;
}

/** 项目详情里每条沟通的编号和下一步时间（不是企业版给空的） */
export async function 沟通编号们(followUpIds: string[]): Promise<Map<string, { code: string; nextAt: Date | null }>> {
  if (!企业版() || !followUpIds.length) return new Map();
  const 们 = await prisma.entFollowUpMeta.findMany({ where: { followUpId: { in: followUpIds } }, select: { followUpId: true, code: true, nextAt: true } });
  return new Map(们.map((m) => [m.followUpId, { code: m.code, nextAt: m.nextAt }]));
}
