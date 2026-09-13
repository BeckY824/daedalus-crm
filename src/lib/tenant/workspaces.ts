import fs from "node:fs";
import path from "node:path";
import { control } from "./control";
import { workspaceClient, workspaceDir, workspaceDbPath } from "./clients";
import type { TenantContext } from "./context";

/**
 * 工作区的生命周期：开户、解析、试用与订阅状态。
 *
 * 开一个工作区 = 复制模板库文件 + 在控制面记一行 + 往新库里写第一个人。
 * 复制文件而不是建表，理由见 scripts/build-template.mjs。
 */

/** 试用多少天。你定的 7 天 */
export const TRIAL_DAYS = 7;

export type WorkspaceStatus = "TRIAL" | "ACTIVE" | "EXPIRED" | "SUSPENDED";

export function templatePath(): string {
  return process.env.WORKSPACE_TEMPLATE ?? path.join(workspaceDir(), "_template.db");
}

/**
 * 把名字变成能当文件名和网址用的 slug。
 * 中文名占多数，转不出拉丁字母时退回随机串——slug 只要唯一、能进 URL，不必好看。
 */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/[一-龥]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const rand = Math.random().toString(36).slice(2, 8);
  return base ? `${base}-${rand}` : `ws-${rand}`;
}

/** 试用 / 订阅算下来现在能不能写 */
export function computeWritable(w: { status: string; trialEndsAt: Date; paidUntil: Date | null }, now = new Date()): boolean {
  if (w.status === "SUSPENDED") return false;
  if (w.paidUntil && w.paidUntil > now) return true;
  if (w.status === "ACTIVE") return false; // 标成已付费但过了期，按过期处理
  return w.trialEndsAt > now;
}

/** 还剩几天（试用或订阅）。过期为 0 */
export function daysLeft(w: { trialEndsAt: Date; paidUntil: Date | null }, now = new Date()): number {
  const end = w.paidUntil && w.paidUntil > w.trialEndsAt ? w.paidUntil : w.trialEndsAt;
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000));
}

/**
 * 开一个新工作区，并把 account 设为 OWNER。
 * 失败时把已经复制出去的库文件删掉，不留孤儿文件。
 */
export async function createWorkspace(input: {
  name: string;
  account: { id: string; name: string; email?: string | null; phone?: string | null };
}): Promise<{ id: string; slug: string; dbFile: string }> {
  const tpl = templatePath();
  if (!fs.existsSync(tpl)) {
    throw new Error(`模板库不存在：${tpl}。先跑 scripts/build-template.mjs`);
  }

  const slug = slugify(input.name);
  const dbFile = `${slug}.db`;
  const target = workspaceDbPath(dbFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) throw new Error("工作区标识冲突，请重试");
  fs.copyFileSync(tpl, target);

  try {
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86_400_000);
    const ws = await control.workspace.create({
      data: { slug, name: input.name.trim().slice(0, 40), dbFile, status: "TRIAL", trialEndsAt },
    });
    await control.membership.create({ data: { accountId: input.account.id, workspaceId: ws.id, role: "OWNER" } });

    /**
     * 新库里的第一个人：工作区创建者，角色管理员（他要能进设置页配 AI 和业务术语）。
     *
     * 注意这会撞上「管理员不承担销售职责」那条规则——见 lib/owners.ts，
     * 那里为「工作区只有一个人」的情况留了回退，否则新用户连第一条客户都建不出来。
     */
    const db = workspaceClient(dbFile);
    const owner = await db.user.create({
      data: {
        // 业务库仍以 email 作为登录名字段，托管版不用它登录，但要唯一且非空
        email: input.account.email?.trim() || `${input.account.phone ?? ws.slug}@workspace.local`,
        // 托管版登录走控制面账号，业务库这条记录不参与密码校验，存一个不可用的占位
        password: "!managed",
        name: input.account.name,
        role: "ADMIN",
        title: "管理员",
      },
    });
    await db.workspaceAccount.create({ data: { userId: owner.id, accountId: input.account.id } });
    return { id: ws.id, slug: ws.slug, dbFile };
  } catch (e) {
    fs.rmSync(target, { force: true });
    for (const s of ["-wal", "-shm"]) fs.rmSync(`${target}${s}`, { force: true });
    throw e;
  }
}

/** 某个账号能进的工作区，附带各自的角色与剩余天数 */
export async function listWorkspacesFor(accountId: string) {
  const rows = await control.membership.findMany({
    where: { accountId },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((m) => ({
    id: m.workspace.id,
    slug: m.workspace.slug,
    name: m.workspace.name,
    role: m.role,
    status: m.workspace.status as WorkspaceStatus,
    writable: computeWritable(m.workspace),
    daysLeft: daysLeft(m.workspace),
  }));
}

/**
 * 组装请求上下文：这个账号在这个工作区里是什么角色、现在能不能写。
 * 不是成员就返回 null——调用方据此 404，不泄露工作区是否存在。
 */
export async function resolveTenant(accountId: string, workspaceId: string): Promise<TenantContext | null> {
  const m = await control.membership.findUnique({
    where: { accountId_workspaceId: { accountId, workspaceId } },
    include: { workspace: true },
  });
  if (!m) return null;
  return {
    workspaceId: m.workspace.id,
    slug: m.workspace.slug,
    dbFile: m.workspace.dbFile,
    role: m.role,
    writable: computeWritable(m.workspace),
  };
}
