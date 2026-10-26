/**
 * 企业版沟通记录编号（2026-10-26）：项目上的每条沟通记一个 FUL + yyyyMMdd + 6 位当天流水，和这条的下一步时间
 * （时限提醒按它算，见 blocker-rules.ts 时限提醒of）。项目上记沟通、建档向导的首条跟进都走这里。
 * 只用传进来的 tx；不是企业版什么都不写。
 * 建档向导（客户端组件 ProjectWizard 引 wizard.ts）也引这里，所以不能带 prisma：读编号的 沟通编号们 在 blocker.ts
 */
import type { Prisma } from "@/generated/prisma";
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
