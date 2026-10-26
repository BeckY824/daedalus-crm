"use server";

/**
 * 企业版提成的写（2026-10-26，迁移 051）：项目底价、组长分配、提成比例 A / B。
 * 项目模式没开、不是企业版：每个动作直接拦，一行不写、不记操作记录。
 * 读写和谁能改在 lib/project/commission-db.ts、算法在 lib/project/commission.ts，这里只管登录、开关、操作记录和刷新
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { 不在了 } from "@/lib/not-there";
import { getBusiness } from "@/lib/business";
import { 企业版 } from "@/lib/enterprise/switch";
import { 看全部 } from "@/lib/team-scope";
import { 存项目底价 as 存底价, 存提成分配 as 存分配, 改提成比例 as 改比例 } from "@/lib/project/commission-db";
import type { 分配 } from "@/lib/project/commission";

const 没开 = { ok: false as const, error: "项目模式没开：请老板在「设置 → 业务配置」里打开" };
const 不是企业版 = { ok: false as const, error: "提成是企业版的功能" };

async function 开着(): Promise<boolean> {
  return (await getBusiness()).projectMode === true;
}

function 刷新项目(projectId: string, customerId?: string) {
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  if (customerId) revalidatePath(`/customers/${customerId}`);
}

const 钱 = (n: number | null | undefined) => (n == null ? "空" : String(n));

/** 项目负责人填、改、清项目底价（只有负责人，用户 10-26 定） */
export async function 存项目底价(projectId: string, 底价: number | null) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    if (!企业版()) return 不是企业版;
    const r = await 存底价(me, projectId, 底价);
    if (r.ok && r.变了) {
      await recordAudit({
        user: me, action: "update", entity: "EntCommission", entityId: projectId,
        summary: `项目「${r.name ?? ""}」的项目底价：${钱(r.前)} → ${钱(r.后)}${r.固定了 ? "（已在订单阶段，实际提成按现在的比例固定）" : ""}`,
        detail: { 项目底价: { 前: r.前 ?? null, 后: r.后 ?? null }, 固定了: !!r.固定了 },
      });
      刷新项目(projectId, r.customerId);
    }
    return r.ok ? { ok: true as const, 变了: r.变了 } : r;
  } catch (e) { return 不在了(e); }
}

/** 组长 / 管理员改提成分配（组员 id → 百分数；合计 ≤ 100%，剩下的归组长） */
export async function 存提成分配(projectId: string, 分: 分配) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    if (!企业版()) return 不是企业版;
    const r = await 存分配(me, projectId, 分);
    if (r.ok && r.变了) {
      const 后 = r.后 ?? {};
      const ids = [...new Set([...Object.keys(后), ...Object.keys(r.前 ?? {})])];
      const 名 = new Map((await 看全部(() => prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }))).map((u) => [u.id, u.name]));
      const 给出去 = Object.values(后).reduce((a, v) => a + Math.round(v * 100), 0) / 100;
      const 说 = [...Object.entries(后).map(([uid, v]) => `${名.get(uid) ?? "已不在的成员"} ${v}%`), `组长 ${Math.round((100 - 给出去) * 100) / 100}%`].join("，");
      await recordAudit({
        user: me, action: "update", entity: "EntCommission", entityId: projectId,
        summary: `项目「${r.name ?? ""}」的提成分配：${说}`,
        detail: { 前: r.前 ?? {}, 后 },
      });
      刷新项目(projectId, r.customerId);
    }
    return r.ok ? { ok: true as const, 变了: r.变了 } : r;
  } catch (e) { return 不在了(e); }
}

/** 老板 / 总管理员改提成比例 A（底价）、B（溢价），百分数 */
export async function 改提成比例(input: { 底价比例: number; 溢价比例: number }) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    if (!企业版()) return 不是企业版;
    const r = await 改比例(me, input ?? {});
    if (r.ok && r.变了) {
      await recordAudit({
        user: me, action: "update", entity: "Setting", entityId: "entCommissionRates",
        summary: `提成比例：底价 ${r.前.底价比例}% → ${r.后.底价比例}%，溢价 ${r.前.溢价比例}% → ${r.后.溢价比例}%`,
        detail: { 前: r.前, 后: r.后 },
      });
      revalidatePath("/settings");
      revalidatePath("/projects", "layout");
    }
    return r.ok ? { ok: true as const, 变了: r.变了 } : r;
  } catch (e) { return 不在了(e); }
}
