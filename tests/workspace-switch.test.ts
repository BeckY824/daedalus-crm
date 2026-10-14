import { beforeAll, afterAll, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { 建控制库 } from "./r2-ai-harness";
import { closeTestDatabases } from "./close-databases";
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({
  get: (key: string) => jar.has(key) ? { value: jar.get(key)! } : undefined,
  set: (key: string, value: string) => jar.set(key, value), delete: (key: string) => jar.delete(key),
}) }));
const root = path.join(os.tmpdir(), `crm-workspace-switch-${process.pid}`);
beforeAll(() => {
  建控制库(root); process.env.MULTI_TENANT = "1"; process.env.WORKSPACE_DIR = root;
  process.env.WORKSPACE_TEMPLATE = path.join(root, "_template.db");
  execFileSync(process.execPath, ["--experimental-sqlite", "scripts/build-template.mjs", process.env.WORKSPACE_TEMPLATE], { stdio: "pipe" });
});
afterAll(async () => {
  delete process.env.MULTI_TENANT; delete process.env.WORKSPACE_DIR; delete process.env.WORKSPACE_TEMPLATE;
  await closeTestDatabases(root); fs.rmSync(root, { recursive: true, force: true });
});
async function fixture(prefix: string) {
  const { createAccount } = await import("@/lib/tenant/accounts");
  const { createWorkspace } = await import("@/lib/tenant/workspaces");
  const acc = await createAccount({ target: { kind: "email", value: `${prefix}@example.test` }, password: "test-pass-123", name: prefix });
  const one = await createWorkspace({ name: `${prefix}一`, slug: `${prefix}-one`, account: acc });
  const two = await createWorkspace({ name: `${prefix}二`, slug: `${prefix}-two`, account: acc });
  return { acc, one, two };
}
it("多工作区登录带去选择，不能直接默默进首个", async () => {
  const { acc } = await fixture("login-choice");
  const { login } = await import("@/app/login/actions");
  expect(await login(acc.email!, "test-pass-123")).toMatchObject({ ok: true, 选工作区: true });
});
it("已缓存会话撤销当前成员后立即失效", async () => {
  const { acc, one } = await fixture("revoked");
  const { createSession, getCurrentUser } = await import("@/lib/auth");
  const { control } = await import("@/lib/tenant/control");
  await createSession(acc.id, one.id);
  expect(await getCurrentUser()).not.toBeNull();
  await control.membership.delete({ where: { accountId_workspaceId: { accountId: acc.id, workspaceId: one.id } } });
  expect(await getCurrentUser()).toBeNull();
});
it("同账号切换只访问目标库；未授权、已撤销、缺映射及停用用户均拒绝且不换会话", async () => {
  const { acc, one, two } = await fixture("switch");
  const outsider = await fixture("outsider");
  const { createSession, getCurrentUser, COOKIE } = await import("@/lib/auth");
  const { 切换工作区 } = await import("@/app/workspaces/actions");
  const { workspaceClient } = await import("@/lib/tenant/clients");
  const { control } = await import("@/lib/tenant/control");
  const { prisma } = await import("@/lib/prisma");
  const { accessibleWorkspacesFor } = await import("@/lib/tenant/workspace-access");
  for (const [ws, name] of [[one, "甲库客户"], [two, "乙库客户"]] as const) {
    const db = workspaceClient(ws.dbFile); const owner = await db.user.findFirstOrThrow();
    await db.customer.create({ data: { id: "same-customer", name, phone: "13800000000", salesOwnerId: owner.id } });
  }
  await createSession(acc.id, one.id);
  jar.set("crm_last_customer", "same-customer");
  const firstToken = jar.get(COOKIE);
  expect(await 切换工作区(outsider.one.id)).toMatchObject({ ok: false });
  expect(jar.get(COOKIE)).toBe(firstToken);
  expect(await 切换工作区(two.id)).toEqual({ ok: true });
  expect(jar.has("crm_last_customer")).toBe(false);
  expect(await getCurrentUser()).toMatchObject({ accountId: acc.id, workspaceId: two.id });
  expect(await prisma.customer.findUnique({ where: { id: "same-customer" } })).toMatchObject({ name: "乙库客户" });
  expect(await 切换工作区(one.id)).toEqual({ ok: true });
  expect(await prisma.customer.findUnique({ where: { id: "same-customer" } })).toMatchObject({ name: "甲库客户" });
  const db = workspaceClient(two.dbFile); const owner = await db.user.findFirstOrThrow();
  await db.user.update({ where: { id: owner.id }, data: { active: false } });
  expect(await 切换工作区(two.id)).toMatchObject({ ok: false });
  expect((await accessibleWorkspacesFor(acc.id)).map(w => w.id)).toEqual([one.id]);
  await db.user.update({ where: { id: owner.id }, data: { active: true } });
  await db.workspaceAccount.deleteMany({ where: { accountId: acc.id } });
  expect(await 切换工作区(two.id)).toMatchObject({ ok: false });
  await db.workspaceAccount.create({ data: { accountId: acc.id, userId: owner.id } });
  await control.membership.delete({ where: { accountId_workspaceId: { accountId: acc.id, workspaceId: two.id } } });
  expect(await 切换工作区(two.id)).toMatchObject({ ok: false });
  expect(await getCurrentUser()).toMatchObject({ workspaceId: one.id });
});
it("已停用控制面账号不能换库，改密作废旧会话也不能签新票", async () => {
  const { acc, one, two } = await fixture("cutoff");
  const { createSession, getCurrentUser } = await import("@/lib/auth");
  const { 切换工作区 } = await import("@/app/workspaces/actions");
  const { control } = await import("@/lib/tenant/control");
  const { 记一次改密 } = await import("@/lib/tenant/session-cutoff");
  await createSession(acc.id, one.id);
  await control.account.update({ where: { id: acc.id }, data: { active: false } });
  expect(await getCurrentUser()).toBeNull();
  expect(await 切换工作区(two.id)).toMatchObject({ ok: false });
  await control.account.update({ where: { id: acc.id }, data: { active: true } });
  await 记一次改密(acc.id);
  expect(await 切换工作区(two.id)).toMatchObject({ ok: false });
});
it("到期目标仍可只读进入；非法参数与非托管部署拒绝", async () => {
  const { acc, one, two } = await fixture("readonly");
  const { createSession } = await import("@/lib/auth");
  const { 切换工作区 } = await import("@/app/workspaces/actions");
  const { control } = await import("@/lib/tenant/control");
  const { accessibleWorkspacesFor } = await import("@/lib/tenant/workspace-access");
  await createSession(acc.id, one.id);
  for (const bad of [null, 42, {}, "", "x".repeat(101)]) expect(await 切换工作区(bad as string)).toMatchObject({ ok: false });
  await control.workspace.update({ where: { id: two.id }, data: { trialEndsAt: new Date(0), status: "EXPIRED" } });
  expect((await accessibleWorkspacesFor(acc.id)).find(w => w.id === two.id)?.writable).toBe(false);
  expect(await 切换工作区(two.id)).toEqual({ ok: true });
  delete process.env.MULTI_TENANT;
  expect(await 切换工作区(one.id)).toMatchObject({ ok: false });
  process.env.MULTI_TENANT = "1";
});

it("同一毫秒改密也撤销旧票，立即重登可用，再次改密仍撤销刚签的新票",async()=>{
 vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date());
 try{
 const {acc,one,two}=await fixture("same-ms-cutoff");const {createSession,getCurrentUser}=await import("@/lib/auth");const {切换工作区}=await import("@/app/workspaces/actions");const {记一次改密}=await import("@/lib/tenant/session-cutoff");
 await createSession(acc.id,one.id);expect(await getCurrentUser()).not.toBeNull();
 for(let i=0;i<2;i++){await 记一次改密(acc.id);expect(await getCurrentUser()).toBeNull();expect(await 切换工作区(two.id)).toMatchObject({ok:false});await createSession(acc.id,one.id);expect(await getCurrentUser()).not.toBeNull()}
 }finally{vi.useRealTimers()}
});
