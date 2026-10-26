"use server";

/**
 * 公海的动作（2026-10-03，0.46.15 第 6 块）：放进公海、领取、老板分配（2026-10-20）、撤销（每个动作的提示条上都有）。
 * 规矩在 lib/pool.ts、自动掉公海在 lib/pool-db.ts。
 */
import { 转交商机 } from "@/lib/opportunity-activity";
import { revalidatePath } from "next/cache";
import { prisma, defaultClient } from "@/lib/prisma";
import { 看全部, 虚线只读挡 } from "@/lib/team-scope";
import { 管全队客户 } from "@/lib/constants";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { recordAudit } from "@/lib/audit";
import { 钉住老签约 } from "@/lib/contract-owner";
import { 带走并记下, 还项目, type 带走的 } from "@/lib/carry-over-db";
import { 记换负责人 } from "@/lib/owner-log-db";
import type { 带走数 } from "@/lib/carry-over";
import { 拦原负责人, 原负责人不能领回提示 } from "@/lib/enterprise/pool-rules";
import { 领客户带走公海项目 } from "@/lib/enterprise/pool-link";

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
      /** 老板分配：分给了谁（id、名字），撤销时按他认「还归他」 */
      给谁?: { id: string; name: string };
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
  const 虚线 = await 虚线只读挡(defaultClient, ids);
  if (虚线) return { ok: false, error: 虚线 };
  const 这些 = await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, salesOwnerId: true, pool: { select: { customerId: true } } } });
  const 已在 = 这些.filter((c) => c.pool);
  const 能放 = 这些.filter((c) => !c.pool && (管全队客户(me.role) || c.salesOwnerId === me.id));
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
  // 企业版「非原负责人均可领取」（pool-rules.ts，10-26 定稿）：公海里负责人一直留着原来那位，是他的就不让他自己领回
  const 不能领 = 拦原负责人()
    ? new Set((await 看全部(() => prisma.customer.findMany({ where: { id: { in: ids }, salesOwnerId: me.id, pool: { isNot: null } }, select: { id: true } }))).map((c) => c.id))
    : new Set<string>();
  if (不能领.size && 不能领.size === new Set(ids).size) return { ok: false, error: 原负责人不能领回提示 };
  // 换负责人之前先把老签约「签约那一刻是谁的」钉住（排查 X1，和批量分配一样）
  await 钉住老签约();
  const 领到: { id: string; 值: string }[] = [];
  for (const id of [...new Set(ids)].filter((x) => !不能领.has(x))) {
    /*
      看全部（团队版业务员，lib/team-scope.ts）：业务员能领，是因为这位在公海里；删掉公海那一行之后、负责人改成我之前，
      他在业务员眼里「不见了」——限定着读会读不到、返回 null，公海那一行却已经删了：客户出了公海、没归任何领的人（2026-10-04 五人实测）。
      能不能领只看「删到了公海那一行」，事务里不用再限定
    */
    /*
      团队范围同步（2026-10-14）：先改负责人、最后删公海那一行。同步日志按这个顺序推，
      哪怕被切进前后两次推送（或连的是还没修的旧服务端，逐包按前一包落下后的状态核）也都过得去：
      改负责人那一刻还在公海（人人可写），删公海那一刻已经归我。反过来先删公海，客户在服务端眼里就成了原负责人的私客、
      这台再改负责人被拒——各台负责人对不上（五台实测）。能不能领仍只看「删到了公海那一行」：删到 0 行就整个回滚。
    */
    const 原 = await 看全部(() => prisma.$transaction(async (tx) => {
      if (!(await tx.customerPool.findUnique({ where: { customerId: id }, select: { customerId: true } }))) return null;
      const c = await tx.customer.findUnique({ where: { id }, select: { salesOwnerId: true } });
      // 客户没了：抛出去整个回滚
      if (!c) throw new Error("客户不在了");
      if (c.salesOwnerId !== me.id) await tx.customer.update({ where: { id }, data: { salesOwnerId: me.id } });
      await tx.customerClaim.upsert({ where: { customerId: id }, update: { userId: me.id, at: new Date() }, create: { customerId: id, userId: me.id } });
      const 删 = await tx.customerPool.deleteMany({ where: { customerId: id } });
      if (!删.count) throw new Error("已被领走");
      return c.salesOwnerId;
    })).catch((e) => {
      if (e instanceof Error && (e.message === "客户不在了" || e.message === "已被领走")) return null;
      throw e;
    });
    if (原 !== null) 领到.push({ id, 值: 原 });
  }
  if (!领到.length) return { ok: true, updated: 0, unchanged: ids.length - 不能领.size, 没权限: 不能领.size };
  const { 数: 带走, 记下: 带过来 } = await 带走并记下(领到.map((x) => ({ customerId: x.id, 旧: x.值 })), me.id, me.id, "claim");
  // 企业版：名下放在项目公海里的项目一起归我（领客户即领项目，pool-link.ts）
  const 公海项目 = await 领客户带走公海项目(领到.map((x) => x.id), me.id, me.id);
  if (公海项目.length) 带走.项目 = (带走.项目 ?? 0) + 公海项目.length;
  await recordAudit({
    user: me, action: "claim", entity: "Customer", entityId: 领到.length === 1 ? 领到[0].id : null,
    summary: `从公海领取 ${领到.length} 名${b.customer}`,
    detail: { ids: 领到.map((x) => x.id), 原负责人: 领到.map((x) => ({ id: x.id, salesOwnerId: x.值 })) },
  });
  刷新(ids);
  return { ok: true, updated: 领到.length, unchanged: ids.length - 领到.length - 不能领.size, 没权限: 不能领.size, 带走, 原负责人: 领到, 带过来 };
}

/**
 * 老板把公海里的客户直接分给一位业务员（2026-10-20，客户需求：原来公海里的只能业务员自己领）。
 * 规矩和领取一模一样，只是「领的人」换成选中的那位：钉住老签约、原负责人没做完的活跟着过去、记领取时间（自动掉公海从它算起）、
 * 能撤销、记操作日志。同步顺序也照领取：先改负责人、最后删公海那一行（删到 0 行 = 已经被人领走，这一位跳过）。
 * 只给老板和业务主管（2026-10-20）；只分给在职成员
 */
export async function 分配公海(ids: string[], userId: string): Promise<公海结果> {
  const me = await requireUser();
  const b = await getBusiness();
  if (!管全队客户(me.role)) return { ok: false, error: `只有老板和业务主管能把公海里的${b.customer}分给同事` };
  const 给 = await prisma.user.findFirst({ where: { id: String(userId ?? ""), active: true }, select: { id: true, name: true } });
  if (!给) return { ok: false, error: "这位同事不在了或已停用，换一位" };
  if (!ids.length) return { ok: true, updated: 0, unchanged: 0, 没权限: 0 };
  await 钉住老签约();
  const 分到: { id: string; 值: string }[] = [];
  for (const id of [...new Set(ids)]) {
    const 原 = await 看全部(() => prisma.$transaction(async (tx) => {
      if (!(await tx.customerPool.findUnique({ where: { customerId: id }, select: { customerId: true } }))) return null;
      const c = await tx.customer.findUnique({ where: { id }, select: { salesOwnerId: true } });
      if (!c) throw new Error("客户不在了");
      if (c.salesOwnerId !== 给.id) await tx.customer.update({ where: { id }, data: { salesOwnerId: 给.id } });
      await tx.customerClaim.upsert({ where: { customerId: id }, update: { userId: 给.id, at: new Date() }, create: { customerId: id, userId: 给.id } });
      const 删 = await tx.customerPool.deleteMany({ where: { customerId: id } });
      if (!删.count) throw new Error("已被领走");
      return c.salesOwnerId;
    })).catch((e) => {
      if (e instanceof Error && (e.message === "客户不在了" || e.message === "已被领走")) return null;
      throw e;
    });
    if (原 !== null) 分到.push({ id, 值: 原 });
  }
  if (!分到.length) return { ok: true, updated: 0, unchanged: ids.length, 没权限: 0 };
  const { 数: 带走, 记下: 带过来 } = await 带走并记下(分到.map((x) => ({ customerId: x.id, 旧: x.值 })), 给.id, me.id, "pool-assign");
  const 公海项目 = await 领客户带走公海项目(分到.map((x) => x.id), 给.id, me.id);
  if (公海项目.length) 带走.项目 = (带走.项目 ?? 0) + 公海项目.length;
  await recordAudit({
    user: me, action: "assign", entity: "Customer", entityId: 分到.length === 1 ? 分到[0].id : null,
    summary: `把公海里 ${分到.length} 名${b.customer}分给「${给.name}」`,
    detail: { ids: 分到.map((x) => x.id), 给: 给.id, 原负责人: 分到.map((x) => ({ id: x.id, salesOwnerId: x.值 })) },
  });
  刷新(ids);
  return { ok: true, updated: 分到.length, unchanged: ids.length - 分到.length, 没权限: 0, 带走, 原负责人: 分到, 带过来, 给谁: 给 };
}

/**
 * 撤销放进公海：把这几位从公海里拿回来，负责人本来就没动过。
 * 撤销领取：负责人还给原来的人、再放回公海；**只还领取时带过来的那几条活**（带过来），
 * 领取之前就归我的计划、待办、商机不动（复查：原来按「我名下没做完的」整个转回去，把我自己的也送走了）。
 * 只撤自己刚才那一下：只认「现在还归我、不在公海」的那几位；原负责人已经停用的不还（还给停用的人等于丢进黑洞），留在我这儿。
 * 撤销分配（老板）：同撤销领取，「我」换成分到的那位（给谁）——只认现在还归他、不在公海的，他名下带过去的活还回去
 */
export async function 撤销公海(动作: "放进" | "领取" | "分配", 原: { id: string; 值: string }[], 带过来?: 带走的, 给谁?: string): Promise<公海结果> {
  const me = await requireUser();
  const ids = 原.map((x) => x.id);
  if (!ids.length) return { ok: true, updated: 0, unchanged: 0, 没权限: 0 };
  if (动作 === "分配" && (!管全队客户(me.role) || !给谁)) return { ok: false, error: "只有老板和业务主管能撤销分配" };
  /** 这几位现在归谁：领取 = 我，分配 = 分到的那位 */
  const 现 = 动作 === "分配" ? 给谁! : me.id;
  if (动作 === "放进") {
    const r = await prisma.customerPool.deleteMany({ where: { customerId: { in: ids }, userId: me.id } });
    刷新(ids);
    return { ok: true, updated: r.count, unchanged: ids.length - r.count, 没权限: 0 };
  }
  const 还归我 = await prisma.customer.findMany({ where: { id: { in: ids }, salesOwnerId: 现, pool: null }, select: { id: true } });
  const 在职的 = new Set((await prisma.user.findMany({ where: { id: { in: 原.map((x) => x.值) }, active: true }, select: { id: true } })).map((u) => u.id));
  const 退 = 原.filter((x) => 还归我.some((c) => c.id === x.id) && 在职的.has(x.值));
  await 钉住老签约();
  for (const x of 退) {
    await prisma.$transaction(async (tx) => {
      // 先放回公海、再把负责人还回去（团队范围同步：放回公海那一刻还归我，之后人人可写；反过来还完负责人我就写不了公海那一行）
      await tx.customerPool.create({ data: { customerId: x.id, userId: me.id, reason: "手动" } });
      // 历史负责人记在还负责人之前：业务员互看时，还完这位就是同事的客户，挂在下面新建会被挡
      await 记换负责人(tx, [{ customerId: x.id, from: 现, to: x.值 }], me.id, "undo");
      await tx.customer.update({ where: { id: x.id }, data: { salesOwnerId: x.值 } });
      await tx.customerClaim.deleteMany({ where: { customerId: x.id, userId: 现 } });
      // 领取 / 分配时带过来的活还回去：还挂在领到的人名下、还没做完的才还
      if (带过来) {
        await tx.followPlan.updateMany({ where: { id: { in: 带过来.计划 }, customerId: x.id, ownerId: 现, done: false }, data: { ownerId: x.值 } });
        await tx.task.updateMany({ where: { id: { in: 带过来.待办 }, customerId: x.id, ownerId: 现, done: false }, data: { ownerId: x.值 } });
        await 转交商机(tx, { id: { in: 带过来.商机 }, customerId: x.id, ownerId: 现, status: "OPEN" }, x.值);
        await 还项目(tx, 带过来.项目, x.id, 现, x.值, me.id);
      }
    });
  }
  刷新(ids);
  return { ok: true, updated: 退.length, unchanged: ids.length - 退.length, 没权限: 0 };
}
