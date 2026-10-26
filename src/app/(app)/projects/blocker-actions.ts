"use server";

/**
 * 企业版卡点的接口（2026-10-26）。读写和谁能动在 lib/project/blocker.ts，这里只管登录、开关、操作日志和刷新。
 * 项目模式没开、不是企业版：每个动作都直接拦，一行不写
 */
import { revalidatePath } from "next/cache";
import { requireUser, type SessionUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { 不在了 } from "@/lib/not-there";
import { getBusiness } from "@/lib/business";
import { 企业版 } from "@/lib/enterprise/switch";
import {
  发布卡点, 指认卡点, 认领卡点, 接受卡点, 转让卡点, 返回卡点, 改卡点进度, 解决卡点, 存卡点默认, 我的卡点, 卡点可选的人,
  type 卡点结果,
} from "@/lib/project/blocker";
import type { 发布输入 } from "@/lib/project/blocker-rules";

const 没开 = { ok: false as const, error: "项目模式没开：请老板在「设置 → 业务配置」里打开" };
const 不是企业版 = { ok: false as const, error: "卡点是企业版的功能" };

async function 拦(): Promise<{ ok: false; error: string } | null> {
  if (!((await getBusiness()).projectMode === true)) return 没开;
  if (!企业版()) return 不是企业版;
  return null;
}

function 刷新(projectId: string) {
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
}

/** 动作做成了：记一行操作日志、刷新项目页 */
async function 收尾(me: SessionUser, r: 卡点结果, 说: (code: string) => string) {
  if (!r.ok) return r;
  await recordAudit({ user: me, action: "update", entity: "EntBlocker", entityId: r.projectId, summary: 说(r.code) });
  刷新(r.projectId);
  return { ok: true as const };
}

export async function 发布卡点Action(followUpId: string, input: 发布输入, assigneeId?: string | null) {
  try {
    const me = await requireUser();
    const 挡 = await 拦();
    if (挡) return 挡;
    const r = await 发布卡点(me, followUpId, input, assigneeId ?? null);
    if (!r.ok) return r;
    await recordAudit({ user: me, action: "create", entity: "EntBlocker", entityId: r.projectId, summary: `发布卡点 ${r.code}` });
    刷新(r.projectId!);
    return { ok: true as const, code: r.code };
  } catch (e) { return 不在了(e); }
}

export async function 指认卡点Action(blockerId: string, userId: string) {
  try {
    const me = await requireUser();
    const 挡 = await 拦();
    if (挡) return 挡;
    return 收尾(me, await 指认卡点(me, blockerId, userId), (c) => `指认卡点 ${c}`);
  } catch (e) { return 不在了(e); }
}

export async function 认领卡点Action(blockerId: string) {
  try {
    const me = await requireUser();
    const 挡 = await 拦();
    if (挡) return 挡;
    return 收尾(me, await 认领卡点(me, blockerId), (c) => `认领卡点 ${c}`);
  } catch (e) { return 不在了(e); }
}

export async function 接受卡点Action(blockerId: string) {
  try {
    const me = await requireUser();
    const 挡 = await 拦();
    if (挡) return 挡;
    return 收尾(me, await 接受卡点(me, blockerId), (c) => `接受卡点 ${c}`);
  } catch (e) { return 不在了(e); }
}

export async function 转让卡点Action(blockerId: string, toUserId: string, 理由?: string) {
  try {
    const me = await requireUser();
    const 挡 = await 拦();
    if (挡) return 挡;
    return 收尾(me, await 转让卡点(me, blockerId, toUserId, 理由), (c) => `转让卡点 ${c}`);
  } catch (e) { return 不在了(e); }
}

export async function 返回卡点Action(blockerId: string, 理由: string) {
  try {
    const me = await requireUser();
    const 挡 = await 拦();
    if (挡) return 挡;
    return 收尾(me, await 返回卡点(me, blockerId, 理由), (c) => `卡点 ${c} 返回看板`);
  } catch (e) { return 不在了(e); }
}

export async function 改卡点进度Action(blockerId: string, patch: { progress?: string; resourceRequest?: string }) {
  try {
    const me = await requireUser();
    const 挡 = await 拦();
    if (挡) return 挡;
    return 收尾(me, await 改卡点进度(me, blockerId, patch), (c) => `更新卡点 ${c} 的处理进度`);
  } catch (e) { return 不在了(e); }
}

export async function 解决卡点Action(blockerId: string, input: { solution?: string; result?: string }) {
  try {
    const me = await requireUser();
    const 挡 = await 拦();
    if (挡) return 挡;
    return 收尾(me, await 解决卡点(me, blockerId, input), (c) => `卡点 ${c} 已解决`);
  } catch (e) { return 不在了(e); }
}

/** 设置 → 项目模式 → 卡点默认值 */
export async function 存卡点默认Action(patch: unknown) {
  try {
    const me = await requireUser();
    const 挡 = await 拦();
    if (挡) return 挡;
    const r = await 存卡点默认(me, patch);
    if (!r.ok) return r;
    await recordAudit({ user: me, action: "update", entity: "Setting", entityId: "entBlockerDefaults", summary: "修改卡点默认值", detail: r.默认 });
    revalidatePath("/settings");
    return { ok: true as const, 默认: r.默认! };
  } catch (e) { return 不在了(e); }
}

/** 指认 / 转让时的下拉：这个项目上在职的负责人和组员 */
export async function 卡点可选的人Action(projectId: string) {
  try {
    const me = await requireUser();
    if (await 拦()) return [];
    return await 卡点可选的人(me, projectId);
  } catch { return []; }
}

/** 「我的卡点」看板（项目列表页）刷新用 */
export async function 我的卡点Action() {
  try {
    const me = await requireUser();
    if (await 拦()) return [];
    return await 我的卡点(me);
  } catch { return []; }
}
