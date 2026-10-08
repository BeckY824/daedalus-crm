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
