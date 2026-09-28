import { prisma } from "./prisma";

/**
 * 表单下拉里「选一个渠道 / 选一个客户」的候选。几张页面都要，口径放在一处：
 * 渠道只列在用的，按名字排；客户全列（排除自己，给「谁介绍来的」那种自引用用）。
 * 负责人候选规则多，单独在 owners.ts。
 */

export function 可选渠道() {
  return prisma.channel.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
}

export function 可选客户(除了?: string) {
  return prisma.customer.findMany({
    where: 除了 ? { id: { not: 除了 } } : undefined,
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}
