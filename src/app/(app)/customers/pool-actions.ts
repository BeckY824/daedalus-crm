"use server";

/**
 * 公海的三个动作（2026-10-03，0.46.15 第 6 块）：放进公海、领取、撤销（两个动作的提示条上都有）。
 * 规矩在 lib/pool.ts、自动掉公海在 lib/pool-db.ts。
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { recordAudit } from "@/lib/audit";
import { 钉住老签约 } from "@/lib/contract-owner";
import { 带走没做完的 } from "@/lib/carry-over-db";
import type { 带走数 } from "@/lib/carry-over";

export type 公海结果 =
  | {
      ok: true;
      /** 真动了几位 */
      updated: number;
      /** 本来就是这样的（已在公海 / 本来就不在公海） */
      unchanged: number;
      /** 不是自己的、自己又不是管理员——放不进去 */
      没权限: number;
      /** 领取时跟着过来的没做完的活 */
      带走?: 带走数;
      /** 领取前各归谁：撤销领取时还给他、放回公海 */
      原负责人?: { id: string; 值: string }[];
    }
  | { ok: false; error: string };

function 刷新(ids: string[]) {
  revalidatePath("/customers");
  if (ids.length === 1) revalidatePath(`/customers/${ids[0]}`);
  revalidatePath("/dashboard");
}

/**
 * 放进公海：负责人本人或管理员才能放（别人的客户你放不进去——那等于替同事把人扔了）。可批量，
 * 不是自己的那几位跳过并说一声。原负责人不动，领的人来了才换。
 */
export async function 放进公海(ids: string[]): Promise<公海结果> {
  const me = await requireUser();
  const b = await getBusiness();
  if (!ids.length) return { ok: true, updated: 0, unchanged: 0, 没权限: 0 };
  const 这些 = await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, salesOwnerId: true, pool: { select: { customerId: true } } } });
  const 已在 = 这些.filter((c) => c.pool);
  const 能放 = 这些.filter((c) => !c.pool && (me.role === "ADMIN" || c.salesOwnerId === me.id));
  const 没权限 = 这些.length - 已在.length - 能放.length;
  if (!能放.length) {
    return 没权限 ? { ok: false, error: `只有负责人或管理员能把${b.customer}放进公海` } : { ok: true, updated: 0, unchanged: 已在.length, 没权限: 0 };
  }
  await prisma.customerPool.createMany({ data: 能放.map((c) => ({ customerId: c.id, userId: me.id, reason: "手动" })) });
  await recordAudit({
    user: me, action: "pool", entity: "Customer", entityId: 能放.length === 1 ? 能放[0].id : null,
    summary: `把 ${能放.length} 名${b.customer}放进公海`,
    detail: { ids: 能放.map((c) => c.id) },
  });
  刷新(ids);
  return { ok: true, updated: 能放.length, unchanged: 已在.length, 没权限 };
}

/**
 * 领取：从公海里拿出来，负责人换成我，原负责人在他身上没做完的活跟着过来（和批量分配同一条规矩）。
 * 只领还在公海里的——两个人同时点，后到的那位这一条算「已被领走」（unchanged）。
 */
export async function 领取(ids: string[]): Promise<公海结果> {
  const me = await requireUser();
  const b = await getBusiness();
  if (!ids.length) return { ok: true, updated: 0, unchanged: 0, 没权限: 0 };
  const 在公海 = await prisma.customer.findMany({ where: { id: { in: ids }, pool: { isNot: null } }, select: { id: true, salesOwnerId: true } });
  if (!在公海.length) return { ok: true, updated: 0, unchanged: ids.length, 没权限: 0 };
  // 换负责人之前先把老签约「签约那一刻是谁的」钉住（排查 X1，和批量分配一样）
  await 钉住老签约();
  const 领到 = 在公海.map((c) => c.id);
  await prisma.$transaction(async (tx) => {
    await tx.customerPool.deleteMany({ where: { customerId: { in: 领到 } } });
    await tx.customer.updateMany({ where: { id: { in: 领到 }, salesOwnerId: { not: me.id } }, data: { salesOwnerId: me.id } });
  });
  const 带走 = await 带走没做完的(在公海.map((c) => ({ customerId: c.id, 旧: c.salesOwnerId })), me.id);
  await recordAudit({
    user: me, action: "claim", entity: "Customer", entityId: 领到.length === 1 ? 领到[0] : null,
    summary: `从公海领取 ${领到.length} 名${b.customer}`,
    detail: { ids: 领到, 原负责人: 在公海.map((c) => ({ id: c.id, salesOwnerId: c.salesOwnerId })) },
  });
  刷新(ids);
  return {
    ok: true, updated: 领到.length, unchanged: ids.length - 领到.length, 没权限: 0, 带走,
    原负责人: 在公海.map((c) => ({ id: c.id, 值: c.salesOwnerId })),
  };
}

/**
 * 撤销放进公海：把这几位从公海里拿回来，负责人本来就没动过。
 * 撤销领取：负责人还给原来的人（没做完的活也跟着回去），再放回公海。
 * 只撤自己刚才那一下：领取的撤销只认「现在还归我」的那几位，期间别人又领走 / 改了的不碰。
 */
export async function 撤销公海(动作: "放进" | "领取", 原: { id: string; 值: string }[]): Promise<公海结果> {
  const me = await requireUser();
  const ids = 原.map((x) => x.id);
  if (!ids.length) return { ok: true, updated: 0, unchanged: 0, 没权限: 0 };
  if (动作 === "放进") {
    const r = await prisma.customerPool.deleteMany({ where: { customerId: { in: ids }, userId: me.id } });
    刷新(ids);
    return { ok: true, updated: r.count, unchanged: ids.length - r.count, 没权限: 0 };
  }
  const 还归我 = await prisma.customer.findMany({ where: { id: { in: ids }, salesOwnerId: me.id, pool: null }, select: { id: true } });
  const 退 = 原.filter((x) => 还归我.some((c) => c.id === x.id));
  await 钉住老签约();
  for (const x of 退) {
    await prisma.$transaction(async (tx) => {
      await tx.customer.update({ where: { id: x.id }, data: { salesOwnerId: x.值 } });
      await tx.customerPool.create({ data: { customerId: x.id, userId: me.id, reason: "手动" } });
    });
  }
  // 没做完的活跟着回去（每位回到各自原来的人手上）
  for (const x of 退) await 带走没做完的([{ customerId: x.id, 旧: me.id }], x.值);
  刷新(ids);
  return { ok: true, updated: 退.length, unchanged: ids.length - 退.length, 没权限: 0 };
}
