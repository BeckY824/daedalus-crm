"use server";

/**
 * 公海的三个动作（2026-10-03，0.46.15 第 6 块）：放进公海、领取、撤销（两个动作的提示条上都有）。
 * 规矩在 lib/pool.ts、自动掉公海在 lib/pool-db.ts。
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { 看全部 } from "@/lib/team-scope";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { recordAudit } from "@/lib/audit";
import { 钉住老签约 } from "@/lib/contract-owner";
import { 带走并记下, type 带走的 } from "@/lib/carry-over-db";
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
      /** 领取时带过来的是哪几条活：撤销只还这几条 */
      带过来?: 带走的;
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
 * 只领还在公海里的。**在事务里逐位删公海那一行、删到了才算我领到**：两个人同时点，后到的那位删到 0 行，
 * 这一位算「已被领走」——原来查和删分在事务两边，两边都报「已领取」，负责人归后到的、活却被先到的带走了（复查）。
 * 领的时间记进 CustomerClaim：自动掉公海从它算起，领走当天没跟进，第二天不会又被扫回去。
 */
export async function 领取(ids: string[]): Promise<公海结果> {
  const me = await requireUser();
  const b = await getBusiness();
  if (!ids.length) return { ok: true, updated: 0, unchanged: 0, 没权限: 0 };
  // 换负责人之前先把老签约「签约那一刻是谁的」钉住（排查 X1，和批量分配一样）
  await 钉住老签约();
  const 领到: { id: string; 值: string }[] = [];
  for (const id of [...new Set(ids)]) {
    /*
      看全部（团队版业务员，lib/team-scope.ts）：业务员能领，是因为这位在公海里；删掉公海那一行之后、负责人改成我之前，
      他在业务员眼里「不见了」——限定着读会读不到、返回 null，公海那一行却已经删了：客户出了公海、没归任何领的人（2026-10-04 五人实测）。
      能不能领只看「删到了公海那一行」，事务里不用再限定
    */
    const 原 = await 看全部(() => prisma.$transaction(async (tx) => {
      const 删 = await tx.customerPool.deleteMany({ where: { customerId: id } });
      if (!删.count) return null;
      const c = await tx.customer.findUnique({ where: { id }, select: { salesOwnerId: true } });
      // 客户没了：抛出去让删公海那一下也回滚
      if (!c) throw new Error("客户不在了");
      if (c.salesOwnerId !== me.id) await tx.customer.update({ where: { id }, data: { salesOwnerId: me.id } });
      await tx.customerClaim.upsert({ where: { customerId: id }, update: { userId: me.id, at: new Date() }, create: { customerId: id, userId: me.id } });
      return c.salesOwnerId;
    })).catch((e) => {
      if (e instanceof Error && e.message === "客户不在了") return null;
      throw e;
    });
    if (原 !== null) 领到.push({ id, 值: 原 });
  }
  if (!领到.length) return { ok: true, updated: 0, unchanged: ids.length, 没权限: 0 };
  const { 数: 带走, 记下: 带过来 } = await 带走并记下(领到.map((x) => ({ customerId: x.id, 旧: x.值 })), me.id);
  await recordAudit({
    user: me, action: "claim", entity: "Customer", entityId: 领到.length === 1 ? 领到[0].id : null,
    summary: `从公海领取 ${领到.length} 名${b.customer}`,
    detail: { ids: 领到.map((x) => x.id), 原负责人: 领到.map((x) => ({ id: x.id, salesOwnerId: x.值 })) },
  });
  刷新(ids);
  return { ok: true, updated: 领到.length, unchanged: ids.length - 领到.length, 没权限: 0, 带走, 原负责人: 领到, 带过来 };
}

/**
 * 撤销放进公海：把这几位从公海里拿回来，负责人本来就没动过。
 * 撤销领取：负责人还给原来的人、再放回公海；**只还领取时带过来的那几条活**（带过来），
 * 领取之前就归我的计划、待办、商机不动（复查：原来按「我名下没做完的」整个转回去，把我自己的也送走了）。
 * 只撤自己刚才那一下：只认「现在还归我、不在公海」的那几位；原负责人已经停用的不还（还给停用的人等于丢进黑洞），留在我这儿。
 */
export async function 撤销公海(动作: "放进" | "领取", 原: { id: string; 值: string }[], 带过来?: 带走的): Promise<公海结果> {
  const me = await requireUser();
  const ids = 原.map((x) => x.id);
  if (!ids.length) return { ok: true, updated: 0, unchanged: 0, 没权限: 0 };
  if (动作 === "放进") {
    const r = await prisma.customerPool.deleteMany({ where: { customerId: { in: ids }, userId: me.id } });
    刷新(ids);
    return { ok: true, updated: r.count, unchanged: ids.length - r.count, 没权限: 0 };
  }
  const 还归我 = await prisma.customer.findMany({ where: { id: { in: ids }, salesOwnerId: me.id, pool: null }, select: { id: true } });
  const 在职的 = new Set((await prisma.user.findMany({ where: { id: { in: 原.map((x) => x.值) }, active: true }, select: { id: true } })).map((u) => u.id));
  const 退 = 原.filter((x) => 还归我.some((c) => c.id === x.id) && 在职的.has(x.值));
  await 钉住老签约();
  for (const x of 退) {
    await prisma.$transaction(async (tx) => {
      await tx.customer.update({ where: { id: x.id }, data: { salesOwnerId: x.值 } });
      await tx.customerPool.create({ data: { customerId: x.id, userId: me.id, reason: "手动" } });
      await tx.customerClaim.deleteMany({ where: { customerId: x.id, userId: me.id } });
      // 领取时带过来的活还回去：还挂在我名下、还没做完的才还
      if (带过来) {
        await tx.followPlan.updateMany({ where: { id: { in: 带过来.计划 }, customerId: x.id, ownerId: me.id, done: false }, data: { ownerId: x.值 } });
        await tx.task.updateMany({ where: { id: { in: 带过来.待办 }, customerId: x.id, ownerId: me.id, done: false }, data: { ownerId: x.值 } });
        await tx.opportunity.updateMany({ where: { id: { in: 带过来.商机 }, customerId: x.id, ownerId: me.id, status: "OPEN" }, data: { ownerId: x.值 } });
      }
    });
  }
  刷新(ids);
  return { ok: true, updated: 退.length, unchanged: ids.length - 退.length, 没权限: 0 };
}
