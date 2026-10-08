/**
 * 业务员限定的「我」缓存到期时落在交互式事务里（2026-10-08 发版前审查）。
 *
 * SQLite 只开一个连接（lib/sqlite-url.ts）。限定层原来缓存到期就拿全局客户端现查一次「我」——
 * 这句要是在交互式事务里，事务正占着那唯一的连接，现查就在等事务自己，事务超时、保存报错。
 * 现在到期先用旧的、后台再认；忘掉限定() 之后的那次仍现查（角色刚变要马上生效）。
 * 用拷出来的一份库、显式单连接，不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-team-scope-tx-"));
  fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(dir, "A.db"));
  if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(dir, "A.db-wal"));
  return { dir };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  const { 加上限定 } = await import("@/lib/team-scope");
  const raw = new PrismaClient({ datasourceUrl: `file:${path.join(临时.dir, "A.db")}?connection_limit=1` });
  return { prisma: 加上限定(raw), defaultClient: raw };
});

import { prisma as db, defaultClient as raw } from "@/lib/prisma";
import { 忘掉限定, 限定的我 } from "@/lib/team-scope";

const 小王 = "acct_wang";
const 老板 = "acct_boss";
const 缓存 = () => (globalThis as unknown as { __限定?: { 我: string | null; 到: number } }).__限定;

beforeAll(async () => {
  process.env.DESKTOP_LOCAL = "1";
  process.env.CRM_DATA_DIR = 临时.dir;
  for (const t of ["AiConversation", "AiProject", "Setting", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "ContractOwner", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerPool", "CustomerClaim"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.user.create({ data: { id: 老板, email: "boss@x.com", name: "老板", password: "x", role: "ADMIN" } });
  await raw.user.create({ data: { id: 小王, email: "wang@x.com", name: "小王", password: "x", role: "SALES" } });
  await raw.customer.create({ data: { name: "小王的客户", phone: "13800000001", salesOwnerId: 小王 } });
  await raw.customer.create({ data: { name: "老板的客户", phone: "13800000002", salesOwnerId: 老板 } });
  fs.writeFileSync(path.join(临时.dir, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: "dk_test", accountId: "wang", name: "小王", contact: "wang@x.com", models: [], loggedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(临时.dir, ".team.json"), JSON.stringify({ teamId: "t1xxxxxxxxxx", teamName: "队", joinSecret: "s", key: "k".repeat(43), device: "dWANG01", pulled: 0 }));
  忘掉限定();
});

afterAll(async () => {
  delete process.env.DESKTOP_LOCAL;
  delete process.env.CRM_DATA_DIR;
  忘掉限定();
  await raw.$disconnect();
  fs.rmSync(临时.dir, { recursive: true, force: true });
});

describe("限定的「我」缓存到期时在事务里", () => {
  it("事务里的查询不等自己：照常限定、不超时", async () => {
    expect((await db.customer.findMany()).map((c) => c.name)).toEqual(["小王的客户"]); // 认过一次
    缓存()!.到 = 0; // 到期
    const 起 = Date.now();
    const 看到 = await db.$transaction(async (tx) => (await tx.customer.findMany()).map((c) => c.name), { timeout: 3000 });
    expect(Date.now() - 起, "事务里等了自己的连接").toBeLessThan(2000);
    expect(看到, "到期那一下用旧的，照样只看自己的").toEqual(["小王的客户"]);
    // 后台那一查排在事务后面，事务完了就认好
    await expect.poll(() => (缓存()?.到 ?? 0) > Date.now()).toBe(true);
  });

  it("忘掉限定() 之后现查：角色刚变就生效", async () => {
    await raw.user.update({ where: { id: 小王 }, data: { role: "ADMIN" } });
    忘掉限定();
    expect(await 限定的我(raw)).toBeNull();
    expect((await db.customer.findMany()).length).toBe(2);
    await raw.user.update({ where: { id: 小王 }, data: { role: "SALES" } });
    忘掉限定();
    expect(await 限定的我(raw)).toBe(小王);
  });
});
