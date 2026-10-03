"use server";

import { revalidatePath } from "next/cache";
import { requireUser, createSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { 本机我 } from "@/lib/desktop/me";
import { recordAudit } from "@/lib/audit";
import { 团队状态, 建团队, 加入团队, 同步一轮, 退出团队 } from "@/lib/sync/client";
import { 疑似重复 } from "@/lib/sync/dupes";

/**
 * 设置 → 团队（2026-10-03，团队同步）。只在桌面端本地模式有这一栏；真正的活在 lib/sync/client.ts。
 * 建团队、加入、退出都留日志：「这台电脑什么时候开始和谁同步」事后要答得上来。
 *
 * 建团队 / 加入会**改本机管理员的 id**（改成按云端账号算的，见 lib/sync/local.ts 改身份）：
 * 手上这张会话票写的还是旧 id，下一个请求就会被当成没登录。所以成功之后按新 id 重签一张，日志也记在新 id 上。
 */
async function 换票() {
  const 我 = await 本机我(prisma);
  if (!我) return null;
  await createSession(我.id);
  return prisma.user.findUnique({ where: { id: 我.id }, select: { id: true, name: true } });
}
export async function 读团队状态() {
  await requireUser();
  const s = await 团队状态();
  return s.在团队 ? { ...s, 重复: await 疑似重复() } : s;
}

export async function 建团队动作(名字: string) {
  await requireUser();
  const r = await 建团队(String(名字 ?? ""));
  const me = r.ok ? await 换票() : null;
  if (r.ok && me) {
    await recordAudit({ user: me, action: "create", entity: "Setting", entityId: "team", summary: `建了团队「${String(名字).trim()}」，这台电脑开始团队同步` });
    revalidatePath("/", "layout");
  }
  return r;
}

export async function 加入团队动作(邀请码: string) {
  await requireUser();
  const r = await 加入团队(String(邀请码 ?? ""));
  const me = r.ok ? await 换票() : null;
  if (r.ok && me) {
    await recordAudit({ user: me, action: "update", entity: "Setting", entityId: "team", summary: `加入了团队「${r.teamName}」，这台电脑开始团队同步` });
    revalidatePath("/", "layout");
  }
  return r;
}

export async function 立即同步() {
  await requireUser();
  const r = await 同步一轮();
  revalidatePath("/", "layout");
  return r;
}

export async function 退出团队动作() {
  const me = await requireUser();
  const r = await 退出团队();
  if (r.ok) await recordAudit({ user: me, action: "update", entity: "Setting", entityId: "team", summary: "退出了团队，这台电脑不再同步（本机数据都还在）" });
  return r;
}
