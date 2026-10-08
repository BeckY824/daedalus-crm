import { closeTestDatabases } from "./close-databases";
/**
 * 托管版：在「编辑成员」框里把停用的人拨回在职（T-036，2026-10-02 排查 A4）。
 *
 * 停用会撤掉控制面的成员资格（deactivateUser → 撤成员），恢复按钮会补回来（reactivateUser → 复成员）。
 * 编辑框那条路原来只改了业务库的 active，提示「已保存」，那个人照样登不进来——管理员找不到原因。
 * e3ee72c 在 saveUser 里补了同一步；这里走真的 Server Action（saveUser / deactivateUser），
 * 只把「登录的是谁」「当前哪个工作区」换成测试给的。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 登录的 = vi.hoisted(() => ({ user: null as null | { id: string; name: string; email: string; role: string; title: string; avatar: null } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (原) => ({
  ...(await 原<object>()),
  requireUser: async () => {
    if (!登录的.user) throw new Error("没登录");
    return 登录的.user;
  },
}));
// 当前工作区 = runWithTenant 给的那个（真请求里是读 cookie、验会话）
vi.mock("@/lib/tenant/resolve", async () => {
  const { currentTenant } = await import("@/lib/tenant/context");
  return { resolveCurrentTenant: async () => currentTenant(), clearTenantCache: () => {} };
});

const 临时根 = path.join(os.tmpdir(), `crm-member-reactivate-${process.pid}`);
const 模板 = path.join(临时根, "_template.db");

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  execFileSync("node", ["--experimental-sqlite", "scripts/build-template.mjs", 模板], { stdio: "pipe" });
  process.env.MULTI_TENANT = "1";
  process.env.WORKSPACE_DIR = 临时根;
  process.env.WORKSPACE_TEMPLATE = 模板;
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时根, "control.db")}`;
  const sql = execFileSync(
    process.execPath,
    [path.resolve("node_modules/prisma/build/index.js"), "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const ddl = path.join(临时根, "control.sql");
  fs.writeFileSync(ddl, sql);
  execFileSync("node", ["--experimental-sqlite", "-e", `
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const db = new DatabaseSync(process.argv[1]);
    db.exec(fs.readFileSync(process.argv[2], 'utf8'));
    db.close();
  `, path.join(临时根, "control.db"), ddl], { stdio: "pipe" });
});

afterAll(async () => {
  delete process.env.MULTI_TENANT;
  await closeTestDatabases(临时根);
  fs.rmSync(临时根, { recursive: true, force: true });
});

it("T-037：尝试停用创建者，拒绝前不能转走客户或更改在职状态", async () => {
  const { createAccount } = await import("@/lib/tenant/accounts");
  const { createWorkspace } = await import("@/lib/tenant/workspaces");
  const { runWithTenant } = await import("@/lib/tenant/context");
  const { prisma } = await import("@/lib/prisma");
  const { control } = await import("@/lib/tenant/control");
  const { saveUser, deactivateUser } = await import("@/app/(app)/settings/actions");
  const acc = await createAccount({ target: { kind: "email", value: "owner-t037@example.com" }, password: "abcd1234", name: "创建者" });
  const ws = await createWorkspace({ name: "T037", account: acc });
  await runWithTenant({ workspaceId: ws.id, slug: ws.slug, dbFile: ws.dbFile, role: "OWNER", writable: true }, async () => {
    const boss = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
    登录的.user = { ...boss, title: boss.title ?? "", avatar: null };
    expect((await saveUser({ name: "另一个管理员", email: "admin-t037@example.com", title: "管理员", role: "ADMIN", active: true, password: "abcd1234" })).ok).toBe(true);
    const receiver = await prisma.user.findFirstOrThrow({ where: { email: "admin-t037@example.com" } });
    const c = await prisma.customer.create({ data: { name: "QA-owner", phone: "", salesOwnerId: boss.id } });
    const result = await deactivateUser(boss.id, receiver.id);
    expect(result).toEqual({ ok: false, error: "工作区创建者不能停用" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: boss.id } })).active).toBe(true);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).salesOwnerId).toBe(boss.id);
    expect((await control.membership.findUniqueOrThrow({ where: { accountId_workspaceId: { accountId: acc.id, workspaceId: ws.id } } })).role).toBe("OWNER");
  });
});

describe("编辑框把停用的人拨回在职：成员资格一起补回来（T-036）", () => {
  it("新建成员 → 停用（撤成员资格）→ 编辑框勾回在职：他又属于这个工作区、登得进来", async () => {
    const { createAccount, verifyAccount } = await import("@/lib/tenant/accounts");
    const { createWorkspace, listWorkspacesFor } = await import("@/lib/tenant/workspaces");
    const { runWithTenant } = await import("@/lib/tenant/context");
    const { prisma } = await import("@/lib/prisma");
    const { saveUser, deactivateUser } = await import("@/app/(app)/settings/actions");

    const 老板号 = await createAccount({ target: { kind: "email", value: "boss-t036@example.com" }, password: "abcd1234", name: "老板" });
    const ws = await createWorkspace({ name: "T036 团队", account: 老板号 });
    const ctx = { workspaceId: ws.id, slug: ws.slug, dbFile: ws.dbFile, role: "OWNER", writable: true };

    await runWithTenant(ctx, async () => {
      const 老板 = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN", active: true } });
      登录的.user = { id: 老板.id, name: 老板.name, email: 老板.email, role: "ADMIN", title: 老板.title ?? "", avatar: null };

      const 建 = await saveUser({ name: "王五", email: "wangwu-t036@example.com", title: "销售", role: "SALES", active: true, password: "wangwu12345" });
      expect(建.ok, JSON.stringify(建)).toBe(true);
      const 王五 = await prisma.user.findFirstOrThrow({ where: { email: "wangwu-t036@example.com" } });
      const 账号 = (await verifyAccount("wangwu-t036@example.com", "wangwu12345"))!;
      expect(账号, "新建的成员应当登得进来").not.toBeNull();
      expect((await listWorkspacesFor(账号.id)).map((w) => w.id)).toEqual([ws.id]);

      const 停 = await deactivateUser(王五.id, 老板.id);
      expect(停.ok, JSON.stringify(停)).toBe(true);
      expect(await listWorkspacesFor(账号.id), "停用撤掉了成员资格").toEqual([]);

      // 不点「恢复」，而是在编辑框里把「在职」勾回来、保存
      const 改 = await saveUser({ id: 王五.id, name: "王五", email: "wangwu-t036@example.com", title: "销售", role: "SALES", active: true });
      expect(改.ok, JSON.stringify(改)).toBe(true);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: 王五.id } })).active).toBe(true);
      expect((await listWorkspacesFor(账号.id)).map((w) => w.id), "提示「已保存」了，那个人得真的登得进来").toEqual([ws.id]);
    });
  });
});
