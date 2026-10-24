import type { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import type { 换负责人记录 } from "@/lib/owner-log";

/**
 * 客户换负责人的记录（企业版 D-36，2026-10-24）：谁转的、从谁到谁、什么时候；from = 「历史负责人」。
 * 换负责人的几条路都走这一处：改负责人 / 批量分配 / 公海领取 / 公海分配（带走并记下）、成员停用转交、两种撤销。
 * 放在换负责人的同一个事务里写：负责人改了、记录没写上的情况不会有
 */
export type 换负责人种类 = "assign" | "claim" | "pool-assign" | "deactivate" | "undo";

export async function 记换负责人(
  tx: Pick<Prisma.TransactionClient, "customerOwnerLog">,
  换: { customerId: string; from: string | null; to: string }[],
  操作人: string,
  kind: 换负责人种类,
): Promise<void> {
  const 真换了 = 换.filter((x) => x.from !== x.to);
  if (!真换了.length) return;
  await tx.customerOwnerLog.createMany({
    data: 真换了.map((x) => ({ customerId: x.customerId, userId: 操作人, fromOwnerId: x.from, toOwnerId: x.to, kind })),
  });
}

/**
 * 详情页的「历史负责人」：这位客户全部换负责人记录，按时间正序，人名换好。
 * 名字按 id 直接查、不挑在职——停用（离职）的人登不进来，但他当过负责人、转过人照旧显示名字
 */
export async function 历史负责人of(customerId: string): Promise<换负责人记录[]> {
  const 记录 = await prisma.customerOwnerLog.findMany({ where: { customerId }, orderBy: [{ at: "asc" }, { id: "asc" }] });
  if (!记录.length) return [];
  const ids = [...new Set(记录.flatMap((r) => [r.userId, r.fromOwnerId, r.toOwnerId]).filter((x): x is string => !!x))];
  const 名 = new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const 叫 = (id: string | null) => (id ? (名.get(id) ?? "已删除的成员") : null);
  return 记录.map((r) => ({ at: r.at.toISOString(), 操作人: 名.get(r.userId) ?? null, 从: 叫(r.fromOwnerId), 到: 叫(r.toOwnerId), kind: r.kind }));
}
