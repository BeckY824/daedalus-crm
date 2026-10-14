import { beforeAll, afterAll, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { 建控制库 } from "./r2-ai-harness";
import { closeTestDatabases } from "./close-databases";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (key: string) => jar.has(key) ? { value: jar.get(key)! } : undefined,
  set: (key: string, value: string) => jar.set(key, value),
  delete: (key: string) => jar.delete(key),
}) }));
const root = path.join(os.tmpdir(), `crm-tenant-quota-${process.pid}`);
beforeAll(() => {
  建控制库(root);
  process.env.MULTI_TENANT = "1";
  process.env.WORKSPACE_DIR = root;
  process.env.WORKSPACE_TEMPLATE = path.join(root, "_template.db");
  execFileSync(process.execPath, ["--experimental-sqlite", "scripts/build-template.mjs", process.env.WORKSPACE_TEMPLATE], { stdio: "pipe" });
});
afterAll(async () => {
  delete process.env.MULTI_TENANT; delete process.env.WORKSPACE_DIR; delete process.env.WORKSPACE_TEMPLATE;
  await closeTestDatabases(root);
  fs.rmSync(root, { recursive: true, force: true });
});

it("真实托管会话携带账户/工作区；两个业务库相同ID不互占限流", async () => {
  const { createAccount } = await import("@/lib/tenant/accounts");
  const { createWorkspace } = await import("@/lib/tenant/workspaces");
  const { workspaceClient } = await import("@/lib/tenant/clients");
  const { createSession, requireUser, getCurrentUser } = await import("@/lib/auth");
  const { consumeUserAiQuota, resetAiQuota, AI_LIMIT } = await import("@/lib/ai-quota");
  const { control } = await import("@/lib/tenant/control");
  const { clearTenantCache } = await import("@/lib/tenant/resolve");
  resetAiQuota();
  const users = [];
  for (const n of [1, 2]) {
    const acc = await createAccount({ target: { kind: "email", value: `quota-${n}@example.test` }, password: "test-pass-123", name: `QA${n}` });
    const ws = await createWorkspace({ name: `QA${n}`, slug: `quota-${n}`, account: acc });
    const db = workspaceClient(ws.dbFile);
    const owner = await db.user.findFirstOrThrow();
    await db.user.update({ where: { id: owner.id }, data: { id: "copied-owner" } });
    await db.workspaceAccount.update({ where: { userId: owner.id }, data: { userId: "copied-owner" } });
    await createSession(acc.id, ws.id);
    const me = await requireUser();
    expect(me).toMatchObject({ id: "copied-owner", accountId: acc.id, workspaceId: ws.id });
    users.push(me);
  }
  for (let i = 0; i < AI_LIMIT; i++) consumeUserAiQuota(users[0]);
  expect(consumeUserAiQuota(users[0])).not.toBeNull();
  expect(consumeUserAiQuota(users[1])).toBeNull();
  // 认证仍必须通过真实成员关系，客户端不能用任意工作区编号选择桶。
  await control.membership.deleteMany({ where: { accountId: users[1].accountId } });
  clearTenantCache();
  expect(await getCurrentUser()).toBeNull();
});


it("真实会话的测试豁免仅限本人和当前工作区，取消、过期及撤销成员后不绕过额度", async () => {
  const { createAccount } = await import("@/lib/tenant/accounts");
  const { createWorkspace } = await import("@/lib/tenant/workspaces");
  const { createSession } = await import("@/lib/auth");
  const { 设测试账号 } = await import("@/lib/tenant/test-accounts");
  const { 带额度 } = await import("@/lib/tenant/ai-allowance");
  const { 读AI计次 } = await import("@/lib/ai-meter");
  const { control } = await import("@/lib/tenant/control");
  const { clearTenantCache } = await import("@/lib/tenant/resolve");
  const acc = await createAccount({ target: { kind: "email", value: "exempt@example.test" }, password: "test-pass-123", name: "测试" });
  const ws = await createWorkspace({ name: "豁免", slug: "exempt", account: acc });
  const other = await createAccount({ target: { kind: "email", value: "ordinary@example.test" }, password: "test-pass-123", name: "普通" });
  // 真实成员映射：同一库里两位成员，仅测试者豁免。
  const { workspaceClient } = await import("@/lib/tenant/clients");
  const db = workspaceClient(ws.dbFile);
  const member = await db.user.create({ data: { name: "普通", email: "ordinary", password: "x", role: "MEMBER", title: "" } });
  await db.workspaceAccount.create({ data: { accountId: other.id, userId: member.id } });
  await control.membership.create({ data: { accountId: other.id, workspaceId: ws.id, role: "MEMBER" } });
  await control.aiGrant.deleteMany({ where: { workspaceId: ws.id } });
  // 固定零额度且不触发懒注册赠送。
  await control.aiGrant.create({ data: { workspaceId: ws.id, amount: 0, reason: "signup", key: `${ws.id}:signup` } });
  const run = vi.fn(async () => ({ ok: true as const }));
  await createSession(acc.id, ws.id); clearTenantCache();
  expect((await 带额度("ask", run)).ok).toBe(false);
  await 设测试账号(acc.id, true, "QA");
  expect((await 带额度("ask", run)).ok).toBe(true);
  expect(await 读AI计次({ 问余额: true })).toMatchObject({ 计次: false });
  expect((await control.aiUsage.findUnique({ where: { workspaceId: ws.id } }))?.calls ?? 0).toBe(0);
  await createSession(other.id, ws.id); clearTenantCache();
  expect((await 带额度("ask", run)).ok).toBe(false);
  expect(await 读AI计次({ 问余额: true })).toMatchObject({ 计次: true, 还剩: 0 });
  await createSession(acc.id, ws.id); clearTenantCache();
  await 设测试账号(acc.id, false, "QA");
  expect((await 带额度("ask", run)).ok).toBe(false);
  await 设测试账号(acc.id, true, "QA");
  await control.workspace.update({ where: { id: ws.id }, data: { trialEndsAt: new Date(0), status: "EXPIRED" } });
  clearTenantCache();
  expect((await 带额度("ask", run)).ok).toBe(false);
  expect(run).toHaveBeenCalledTimes(1);
  await control.workspace.update({ where: { id: ws.id }, data: { paidUntil: new Date(Date.now() + 86400000), status: "SUSPENDED" } });
  clearTenantCache();
  expect((await 带额度("ask", run)).ok).toBe(false);
  expect(run).toHaveBeenCalledTimes(1);
  const { 当前是测试账号 } = await import("@/lib/tenant/test-accounts");
  expect(await 当前是测试账号("another-workspace")).toBe(false);
  await control.membership.deleteMany({ where: { accountId: acc.id, workspaceId: ws.id } });
  clearTenantCache();
  expect(await 当前是测试账号(ws.id)).toBe(false);
});
