"use server";

import { revalidatePath } from "next/cache";
import { requireUser, createSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { 本机我, 团队身份id } from "@/lib/desktop/me";
import { 云端地址 } from "@/lib/desktop/cloud";
import { recordAudit } from "@/lib/audit";
import { 团队状态, 建团队, 加入团队, 同步一轮, 退出团队, 移除成员, 换邀请码, 读价格表 } from "@/lib/sync/client";
import { 疑似重复 } from "@/lib/sync/dupes";
import { 列出范围冲突, 确认范围冲突, 导出范围冲突 } from "@/lib/sync/scoped-local";
import { 列出被盖, 看过被盖 } from "@/lib/sync/overwritten";
import { 待授权手机, 允许手机, 拒绝手机, 我的设备, 移除设备 } from "@/lib/sync/mobile-desktop";
import { 连接概况, 发起连接, 查连接, 取消连接 } from "@/lib/sync/device-link";

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
  // 价格表（2026-10-15）：服务器上的，运营台改了这里就是新价；和团队状态一起拿，不多等一轮
  const [s, 价格] = await Promise.all([团队状态(), 读价格表().catch(() => null)]);
  // 这台还没连上：账号在云上是哪个团队的、是不是在等另一台电脑允许（2026-10-15 多设备同步）
  if (!s.在团队) return { ...s, 价格, 连接: await 连接概况().catch(() => null) };
  // 老板看每个人的客户数和跟进（2026-10-04：老板要看得到业务员的跟进过程）；疑似重复也只给老板看——业务员只看得到自己那一半
  if (!s.我是建的人) return { ...s, 价格, 重复: [] as Awaited<ReturnType<typeof 疑似重复>>, 每人: {} as Record<string, 一人> };
  return { ...s, 价格, 重复: await 疑似重复(), 每人: await 每人概况(s.成员.map((m) => m.accountId)) };
}

type 一人 = { 客户: number; 近7天跟进: number; 最近跟进: string | null; userId: string };

/** 老板那台：每个成员手上几位客户、近 7 天跟进几次、最近一次是什么时候。成员的业务库 id = acct_<云端账号 id> */
async function 每人概况(账号们: string[]): Promise<Record<string, 一人>> {
  const 七天前 = new Date(Date.now() - 7 * 86400_000);
  const 出: Record<string, 一人> = {};
  for (const a of 账号们) {
    const id = 团队身份id(a);
    const [客户, 近7天跟进, 最近] = await Promise.all([
      // 手上的：公海里的（负责人还挂着原来那位）不算，和点进去的客户列表「客户」页签对得上
      prisma.customer.count({ where: { salesOwnerId: id, pool: { is: null } } }),
      prisma.followUp.count({ where: { ownerId: id, occurredAt: { gte: 七天前 } } }),
      prisma.followUp.findFirst({ where: { ownerId: id }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true } }),
    ]);
    出[a] = { 客户, 近7天跟进, 最近跟进: 最近?.occurredAt.toISOString() ?? null, userId: id };
  }
  return 出;
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

/** 移除成员（只有建团队的人）：移出、换邀请码、换钥匙一起做。他电脑上已有的数据收不回 */
export async function 移除成员动作(accountId: string, 名字: string) {
  const me = await requireUser();
  const r = await 移除成员(String(accountId ?? ""));
  if (r.ok) await recordAudit({ user: me, action: "update", entity: "Setting", entityId: "team", summary: `把「${名字}」移出了团队，邀请码和钥匙都换了` });
  return r;
}

/** 换邀请码（只有建团队的人）：旧码作废，钥匙一起换 */
export async function 换邀请码动作() {
  const me = await requireUser();
  const r = await 换邀请码();
  if (r.ok) await recordAudit({ user: me, action: "update", entity: "Setting", entityId: "team", summary: "换了团队邀请码和钥匙，旧邀请码作废" });
  return r;
}

/* ---------------- 范围同步：失权的未上传改动（只列、导出、确认，从不删除） ---------------- */
export async function 读范围冲突() {
  await requireUser();
  return 列出范围冲突(prisma);
}
export async function 导出范围冲突动作() {
  await requireUser();
  return 导出范围冲突(prisma);
}
export async function 确认范围冲突动作(ids: number[]) {
  const me = await requireUser();
  const n = await 确认范围冲突(prisma, Array.isArray(ids) ? ids.map(Number) : []);
  if (n) await recordAudit({ user: me, action: "update", entity: "Setting", entityId: "team", summary: `确认了 ${n} 条失权冲突（只标记已处理，未删除）` });
  revalidatePath("/settings");
  return { ok: true as const, 确认: n };
}

/* ---------------- 被同事盖掉的改动（2026-10-16）：同时改了同一格，同事后改的赢，给我看我原来写的 ---------------- */
export async function 读被盖掉() {
  await requireUser();
  return 列出被盖(prisma);
}
export async function 看过被盖掉动作(ids: number[]) {
  await requireUser();
  const n = await 看过被盖(prisma, Array.isArray(ids) ? ids.map(Number) : []);
  revalidatePath("/settings");
  return { ok: true as const, 看过: n };
}

/* ---------- 手机和本人的新电脑（2026-10-15，手机端方案 3.2 / 多设备同步）：授权。活在 lib/sync/mobile-desktop.ts；列出、移除见下面「我的设备」 ---------- */

export async function 待授权手机动作() {
  await requireUser();
  return 待授权手机();
}

export async function 允许手机动作(id: string, label: string, 电脑 = false) {
  const user = await requireUser();
  const r = await 允许手机(String(id ?? ""));
  const 名 = String(label ?? "").slice(0, 60);
  if (r.ok) await recordAudit({ user, action: "create", entity: "Setting", entityId: 电脑 ? "device" : "mobile", summary: 电脑 ? `授权了自己的另一台电脑（${名}）加入团队同步` : `授权了一台手机（${名}）查看和记录客户` });
  return r;
}

export async function 拒绝手机动作(id: string) {
  await requireUser();
  return 拒绝手机(String(id ?? ""));
}


/* ---------- 多设备同步（2026-10-15）：这台新电脑连上团队、我的设备。活在 lib/sync/device-link.ts、mobile-desktop.ts ---------- */

/** 首页弹框用（components/TeamConnectPrompt）：这台没连上、账号在云上是哪个团队的，是不是已经在等、本机几位客户（不是 / 已连上 = null） */
export async function 待连接团队动作() {
  await requireUser();
  const x = await 连接概况().catch(() => null);
  return x?.云上的团 ? { 团名: x.云上的团.name, 我是建的人: x.云上的团.我是建的人, 等授权: x.等授权, 本机客户: x.本机客户 } : null;
}

export async function 发起连接动作() {
  await requireUser();
  return 发起连接();
}

/** 问另一台电脑点了没；连上了跟加入团队一样：本机管理员 id 改成按云端账号算的，重签会话票、留日志 */
export async function 查连接动作() {
  await requireUser();
  const r = await 查连接();
  if (r.ok && r.status === "joined" && r.teamName !== undefined) {
    const me = await 换票();
    if (me) await recordAudit({ user: me, action: "update", entity: "Setting", entityId: "team", summary: `在另一台电脑上授权后连上了团队「${r.teamName}」，这台电脑开始团队同步` });
    revalidatePath("/", "layout");
  }
  return r;
}

export async function 取消连接动作() {
  await requireUser();
  return 取消连接();
}

export async function 我的设备动作() {
  await requireUser();
  const r = await 我的设备();
  // 手机上打开哪个地址：和这台电脑连的是同一个云端
  return r.ok ? { ...r, 地址: `${云端地址()}/m` } : r;
}

export async function 移除设备动作(device: string, label: string) {
  const user = await requireUser();
  const r = await 移除设备(String(device ?? ""));
  if (r.ok) await recordAudit({ user, action: "delete", entity: "Setting", entityId: "device", summary: `从「我的设备」里移除了「${String(label ?? "").slice(0, 60)}」，它退出登录、不能再同步` });
  return r;
}
