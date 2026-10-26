"use server";

/**
 * 企业版「交接中」（2026-10-26，测试清单 D10）：接手人确认 / 拒收，发起人或管理员撤回，客户页顶上列出等确认的交接。
 * 发起见 settings/actions.ts deactivateUser（离职）和 customers/actions.ts assignSalesOwner（转让），规矩见 lib/enterprise/handover-db.ts。
 * 不是企业版一律什么都不做：列表回空，确认 / 撤回 / 拒收回错
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { 钉住老签约 } from "@/lib/contract-owner";
import { 看全部 } from "@/lib/team-scope";
import { 企业版 } from "@/lib/enterprise/switch";
import { 规则开着 } from "@/lib/enterprise/rules";
import { 停用分拣, 停用方式们, type 停用方式 } from "@/lib/offboard-db";
import { 离职转给接手人, 离职放进公海 } from "@/lib/offboard-move";
import { 带走并记下 } from "@/lib/carry-over-db";
import { 待确认, 了结, 读ids, type 交接种类 } from "@/lib/enterprise/handover-db";
import { getBusiness } from "@/lib/business";

export type 交接行 = {
  id: string;
  kind: 交接种类;
  从: string;
  给: string;
  发起人: string;
  /** 离职的「转交 / 公海」 */
  way: string | null;
  个数: Record<string, number>;
  /** 前几位客户的名字（接手人确认前要知道接的是谁）；客户总数另给 */
  客户: string[];
  客户总数: number;
  createdAt: string;
  我能确认: boolean;
  我能撤回: boolean;
};

const 列几位 = 10;

function 读个数(s: string): Record<string, number> {
  try {
    const v = JSON.parse(s);
    if (!v || typeof v !== "object") return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number"));
  } catch {
    return {};
  }
}

/** 客户页顶上那条：等我确认的 + 我发起、还没确认的（管理员看全部还没确认的） */
export async function 待确认的交接(): Promise<{ 等我确认: 交接行[]; 我发起的: 交接行[] }> {
  const me = await requireUser();
  if (!企业版()) return { 等我确认: [], 我发起的: [] };
  const 管 = me.role === "ADMIN";
  // 看全部：交接里的客户还不归接手人，限定着查他一个名字都拿不到
  return 看全部(async () => {
    const 行 = await prisma.entHandover.findMany({
      // 管理员看全部还没确认的；别人只看给自己的、自己发起的（OR 里放空对象 Prisma 不当「全部」，分开写）
      where: 管 ? { status: 待确认 } : { status: 待确认, OR: [{ toUserId: me.id }, { byUserId: me.id }] },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    if (!行.length) return { 等我确认: [], 我发起的: [] };
    const 人 = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(行.flatMap((h) => [h.fromUserId, h.toUserId, h.byUserId]))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const 前几位 = 行.flatMap((h) => 读ids(h.customerIds).slice(0, 列几位));
    const 名 = new Map((await prisma.customer.findMany({ where: { id: { in: 前几位 } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    const 成行 = (h: (typeof 行)[number]): 交接行 => {
      const ids = 读ids(h.customerIds);
      return {
        id: h.id, kind: h.kind as 交接种类, way: h.way,
        从: 人.get(h.fromUserId) ?? "（已删除的成员）", 给: 人.get(h.toUserId) ?? "（已删除的成员）", 发起人: 人.get(h.byUserId) ?? "（已删除的成员）",
        个数: 读个数(h.counts), 客户: ids.slice(0, 列几位).map((id) => 名.get(id)).filter((x): x is string => !!x), 客户总数: ids.length,
        createdAt: h.createdAt.toISOString(),
        我能确认: h.toUserId === me.id, 我能撤回: h.byUserId === me.id || 管,
      };
    };
    return { 等我确认: 行.filter((h) => h.toUserId === me.id).map(成行), 我发起的: 行.filter((h) => h.toUserId !== me.id).map(成行) };
  });
}

type 结果 = { ok: true; 客户: number } | { ok: false; error: string };
const 已处理 = "这笔交接已经处理过了（被确认、撤回或拒收），刷新看看";

function 刷新() {
  revalidatePath("/customers");
  revalidatePath("/projects");
  revalidatePath("/settings");
}

/**
 * 接手人确认：到这时才真转。离职按此刻重新分拣（发起之后他名下又多出、少了的都对得上），给接手人的那半照离职老规矩转；
 * 转让只转此刻还归原负责人的（中间被人改给了别人的不动），名下的活照整体转的老规矩一起走。
 * 「待确认 → 已确认」带着条件改，和撤回、拒收同时点只成一个
 */
export async function 确认交接(id: string): Promise<结果> {
  const me = await requireUser();
  if (!企业版() || typeof id !== "string" || !id) return { ok: false, error: 已处理 };
  const h = await 看全部(() => prisma.entHandover.findUnique({ where: { id } }));
  if (!h || h.status !== 待确认) return { ok: false, error: 已处理 };
  if (h.toUserId !== me.id) return { ok: false, error: "只有接手人自己能确认" };
  const b = await getBusiness();
  await 钉住老签约();

  if (h.kind === "离职") {
    const 方式: 停用方式 = (停用方式们 as readonly string[]).includes(h.way ?? "") ? (h.way as 停用方式) : "转交";
    const 记分配 = await 规则开着("线索分配");
    const 成 = await 看全部(() => prisma.$transaction(async (tx) => {
      if (!(await 了结(tx, h.id, "已确认", me.id, { toUserId: me.id }))) return null;
      const 分 = await 停用分拣(tx, h.fromUserId, 方式, true);
      const 项目 = await 离职转给接手人(tx, 分, h.fromUserId, me.id, h.byUserId, 记分配);
      // 发起到确认之间又该进公海的（方式 = 公海），这时一起放
      await 离职放进公海(tx, 分, h.byUserId);
      return { 分, 项目 };
    }, { timeout: 30_000 }));
    if (!成) return { ok: false, error: 已处理 };
    const { 分, 项目 } = 成;
    const 从 = (await prisma.user.findUnique({ where: { id: h.fromUserId }, select: { name: true } }))?.name ?? h.fromUserId;
    await recordAudit({
      user: me, action: "deactivate", entity: "User", entityId: h.fromUserId,
      summary: `确认接手离职成员「${从}」的交接：${分.客户.length} 位${b.customer}、${分.商机.length} 个进行中商机、` +
        `${分.计划.length + 分.待办.length} 条没完成的计划和待办、${分.线索.length} 条线索、${分.渠道.length} 个渠道` + (项目.length ? `、${项目.length} 个项目` : ""),
      detail: { 交接: h.id, userId: h.fromUserId, transferToId: me.id, 方式, 客户: 分.客户, 商机: 分.商机, 待办: 分.待办, 计划: 分.计划, 线索: 分.线索, 渠道: 分.渠道, 项目, 进公海客户: 分.进公海客户, 进公海项目: 分.进公海项目 },
    });
    刷新();
    return { ok: true, 客户: 分.客户.length };
  }

  const ids = 读ids(h.customerIds);
  const 换 = await 看全部(() => prisma.$transaction(async (tx) => {
    if (!(await 了结(tx, h.id, "已确认", me.id, { toUserId: me.id }))) return null;
    const 还归他 = (await tx.customer.findMany({ where: { id: { in: ids }, salesOwnerId: h.fromUserId }, select: { id: true } })).map((c) => c.id);
    if (还归他.length) await tx.customer.updateMany({ where: { id: { in: 还归他 } }, data: { salesOwnerId: me.id } });
    return 还归他;
  }));
  if (!换) return { ok: false, error: 已处理 };
  // 名下的活、项目跟着走，每位记一行换负责人（操作人记发起的那位：是他定的转给谁）
  const { 数, 记下 } = await 带走并记下(换.map((customerId) => ({ customerId, 旧: h.fromUserId })), me.id, h.byUserId);
  const 从 = (await prisma.user.findUnique({ where: { id: h.fromUserId }, select: { name: true } }))?.name ?? h.fromUserId;
  await recordAudit({
    user: me, action: "assign", entity: "Customer",
    summary: `确认接手「${从}」转来的 ${换.length} 名${b.customer}，销售负责人改为「${me.name}」` + (ids.length > 换.length ? `（${ids.length - 换.length} 名在交接期间已换了人，没动）` : ""),
    detail: { 交接: h.id, ids: 换, salesOwnerId: me.id, 原负责人: 换.map((id) => ({ id, salesOwnerId: h.fromUserId })), 带走: 数, 带过来: 记下 },
  });
  刷新();
  return { ok: true, 客户: 换.length };
}

/** 发起人或管理员撤回：什么都不转，数据留在原负责人名下。离职的成员仍是停用的（要换接手人就再办一次离职，或恢复成员） */
export async function 撤回交接(id: string): Promise<结果> {
  const me = await requireUser();
  return 了结一笔(me, id, "已撤回", (h) => h.byUserId === me.id || me.role === "ADMIN", "只有发起人或管理员能撤回");
}

/** 接手人拒收：同撤回，数据留在原负责人名下，发起人看操作日志知道被拒了 */
export async function 拒收交接(id: string): Promise<结果> {
  const me = await requireUser();
  return 了结一笔(me, id, "已拒收", (h) => h.toUserId === me.id, "只有接手人自己能拒收");
}

async function 了结一笔(
  me: Awaited<ReturnType<typeof requireUser>>,
  id: string,
  状态: "已撤回" | "已拒收",
  能: (h: { byUserId: string; toUserId: string }) => boolean,
  不能: string,
): Promise<结果> {
  if (!企业版() || typeof id !== "string" || !id) return { ok: false, error: 已处理 };
  const h = await 看全部(() => prisma.entHandover.findUnique({ where: { id } }));
  if (!h || h.status !== 待确认) return { ok: false, error: 已处理 };
  if (!能(h)) return { ok: false, error: 不能 };
  if (!(await 看全部(() => 了结(prisma, h.id, 状态, me.id)))) return { ok: false, error: 已处理 };
  const 人 = new Map((await prisma.user.findMany({ where: { id: { in: [h.fromUserId, h.toUserId] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const n = 读ids(h.customerIds).length;
  await recordAudit({
    user: me, action: h.kind === "离职" ? "deactivate" : "assign", entity: h.kind === "离职" ? "User" : "Customer", entityId: h.kind === "离职" ? h.fromUserId : null,
    summary: `${状态 === "已撤回" ? "撤回" : "拒收"}了「${人.get(h.fromUserId) ?? h.fromUserId}」交给「${人.get(h.toUserId) ?? h.toUserId}」的${h.kind}交接（${n} 位客户），数据留在原负责人名下`,
    detail: { 交接: h.id, kind: h.kind, 状态, fromUserId: h.fromUserId, toUserId: h.toUserId, 客户: 读ids(h.customerIds) },
  });
  刷新();
  return { ok: true, 客户: 0 };
}
