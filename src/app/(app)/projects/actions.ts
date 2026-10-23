"use server";

/**
 * 团队版项目模式 1a 的写（2026-10-23，D-31）。开关关着时每个动作都直接拦，一行不写。
 * 规矩在 lib/project/nodes.ts、读写在 lib/project/db.ts、建档向导在 lib/project/wizard.ts，这里只管登录、开关、操作日志和刷新。
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { 不在了 } from "@/lib/not-there";
import { getBusiness } from "@/lib/business";
import { 规整向导, 向导接着建, type 建好的, type 向导联系人, type 向导项目, type 向导跟进 } from "@/lib/project/wizard";
import { 改节点, 勾交付, 加角色, 改角色, 删项目, 交付项们, type 交付项 } from "@/lib/project/db";
import type { 位置 } from "@/lib/project/nodes";
import { saveCustomer, type CustomerInput } from "../customers/actions";

const 没开 = { ok: false as const, error: "项目模式没开：请老板在「设置 → 业务配置」里打开" };

async function 开着(): Promise<boolean> {
  return (await getBusiness()).projectMode === true;
}

function 刷新项目(projectId?: string, customerId?: string) {
  revalidatePath("/projects");
  if (projectId) revalidatePath(`/projects/${projectId}`);
  if (customerId) revalidatePath(`/customers/${customerId}`);
}

export type 建档向导输入 = { 客户: CustomerInput; 联系人: 向导联系人; 项目: 向导项目; 跟进: 向导跟进 };

/**
 * 建档向导的最后一步：客户、主要联系人、项目、首条跟进一笔建好。
 * 客户查重撞了、哪一步写失败了，整笔都不留；中途关掉向导时根本没走到这里
 */
export async function 建档向导(input: 建档向导输入) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    if (!input || typeof input !== "object" || !input.客户 || typeof input.客户 !== "object") return { ok: false as const, error: "建档信息不完整，请从头再走一遍" };
    const 好 = 规整向导(me, input);
    if ("error" in 好) return { ok: false as const, error: 好.error };
    const 负责人 = await prisma.user.findUnique({ where: { id: 好.项目.ownerId }, select: { name: true, active: true } });
    if (!负责人?.active) return { ok: false as const, error: "项目负责人不存在或已停用，请选一位在职成员" };

    const 建了: Partial<建好的> = {};
    const r = await saveCustomer({ ...input.客户, id: undefined, updatedAt: null, base: null }, 向导接着建(me, 好, 建了));
    if (!r.ok) return r;
    await recordAudit({
      user: me, action: "create", entity: "Project", entityId: 建了.projectId,
      summary: `建档：新建项目「${好.项目.name}」（负责人 ${负责人.name}），连同主要联系人「${好.联系人.name}」和首条跟进`,
      detail: { 项目: 好.项目.name, 负责人: 负责人.name, 金额: 好.项目.amount, 币种: 好.项目.currency, 联系人: 好.联系人.name },
    });
    刷新项目(建了.projectId, r.id);
    revalidatePath("/follow-ups");
    return { ok: true as const, customerId: r.id, projectId: 建了.projectId! };
  } catch (e) { return 不在了(e); }
}

export async function 改项目节点(projectId: string, 到: 位置, 原因?: string | null) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    if (!到 || typeof 到 !== "object") return { ok: false as const, error: "要改到哪个节点？" };
    const r = await 改节点(me, projectId, 到, 原因);
    if (r.ok && r.变了) {
      const p = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true, customerId: true } });
      await recordAudit({
        user: me, action: "update", entity: "Project", entityId: projectId,
        summary: `项目「${p?.name ?? ""}」改到 ${到.phase}·${到.node}${到.result ? `（${到.result}）` : ""}`,
        detail: { 阶段: 到.phase, 节点: 到.node, 结局: 到.result ?? null, 原因: 原因?.trim() || null },
      });
      刷新项目(projectId, p?.customerId);
    }
    return r;
  } catch (e) { return 不在了(e); }
}

export async function 勾项目交付(projectId: string, 项: 交付项, 勾: boolean) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    const r = await 勾交付(me, projectId, 项, 勾 === true);
    if (r.ok && r.变了) {
      const p = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true, customerId: true } });
      await recordAudit({
        user: me, action: "update", entity: "Project", entityId: projectId,
        summary: `项目「${p?.name ?? ""}」${勾 ? "勾上" : "取消"}「${交付项们[项]}」`,
      });
      刷新项目(projectId, p?.customerId);
    }
    return r;
  } catch (e) { return 不在了(e); }
}

export async function 删除项目(projectId: string) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    const r = await 删项目(me, projectId);
    if (r.ok) {
      await recordAudit({ user: me, action: "delete", entity: "Project", entityId: projectId, summary: `删除项目「${r.name}」` });
      刷新项目(undefined, r.customerId);
    }
    return r.ok ? { ok: true as const } : r;
  } catch (e) { return 不在了(e); }
}

export async function 加组员角色(name: string) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    const r = await 加角色(me, name);
    if (r.ok) {
      await recordAudit({ user: me, action: "create", entity: "ProjectRole", entityId: r.id, summary: `加了项目组员角色「${String(name).trim()}」` });
      revalidatePath("/settings");
    }
    return r;
  } catch (e) { return 不在了(e); }
}

export async function 改组员角色(id: string, patch: { name?: string; active?: boolean }) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    const 原 = await prisma.projectRole.findUnique({ where: { id: String(id ?? "") }, select: { name: true } });
    const r = await 改角色(me, id, patch ?? {});
    if (r.ok) {
      const 做了 = patch.active === false ? "停用" : patch.active === true ? "启用" : "改名";
      await recordAudit({
        user: me, action: "update", entity: "ProjectRole", entityId: id,
        summary: `${做了}项目组员角色「${原?.name ?? ""}」${patch.name ? ` → 「${String(patch.name).trim()}」` : ""}`,
      });
      revalidatePath("/settings");
    }
    return r;
  } catch (e) { return 不在了(e); }
}
