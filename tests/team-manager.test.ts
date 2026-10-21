/**
 * 团队版业务主管（2026-10-20，客户「硕诚包装」：老板 → 业务主管 → 业务员）：本机这一半。
 *   - 谁是主管记在中继的成员名单（role = manager），每台按名单对本机 User.role = MANAGER；本机改不了名单
 *   - 主管「看全部，不管人」：看得到全队客户和跟进（不看互看开关）、能改、能指派公海和撤销；业务员照旧只看自己的 + 公海
 *   - 改回业务员：本机角色跟着回 SALES，回到只看自己的 + 公海
 * 用拷出来的一份库（同 team-share.test.ts），不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-team-manager-"));
  fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(dir, "A.db"));
  if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(dir, "A.db-wal"));
  return { dir };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  const { 加上限定 } = await import("@/lib/team-scope");
  const { 单连接 } = await import("@/lib/sqlite-url");
  const raw = new PrismaClient({ datasourceUrl: 单连接(`file:${path.join(临时.dir, "A.db").replaceAll("\\", "/")}`) });
  return { prisma: 加上限定(raw), defaultClient: raw };
});

const 登录的 = vi.hoisted(() => ({ user: { id: "acct_wang", name: "小王", email: "acct_wang@x.com", role: "SALES", title: "销售", avatar: null } as { id: string; name: string; email: string; role: string; title: string; avatar: null } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => 登录的.user }));

import { prisma as db, defaultClient as raw } from "@/lib/prisma";
import { 分配公海, 撤销公海 } from "@/app/(app)/customers/pool-actions";
import { patchCustomer } from "@/app/(app)/customers/actions";
import { 忘掉限定, 限定的我, 读的我, 只读客户 } from "@/lib/team-scope";
import { 设传输, 对齐角色, 设角色, 团队状态, type 传输 } from "@/lib/sync/client";

const 老板 = "acct_boss";
const 小王 = "acct_wang";
const 小李 = "acct_li";

/** 换成哪台电脑：requireUser 的角色照本机库里对出来的（和真的一样，每台按名单对） */
async function 当(账号: "boss" | "wang" | "li") {
  fs.writeFileSync(path.join(临时.dir, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: "dk_test", accountId: 账号, name: 账号, contact: `${账号}@x.com`, models: [], loggedAt: new Date().toISOString() }));
  我是 = 账号;
  忘掉限定();
  await 对齐角色();
  const u = await raw.user.findUniqueOrThrow({ where: { id: `acct_${账号}` } });
  登录的.user = { id: u.id, name: u.name, email: u.email, role: u.role, title: "销售", avatar: null };
}
let 我是 = "wang";
const 云端 = { 互看: false as boolean | undefined };
const 名单 = [{ accountId: "boss", role: "owner" }, { accountId: "wang", role: "member" }, { accountId: "li", role: "member" }];
const 设过: unknown[] = [];
const 假传输: 传输 = async (方法, 路径, body) => {
  // 中继那边：只有老板能设，改的是名单里那一行（sync-relay 设角色）
  if (方法 === "POST" && 路径 === "/api/sync/role") {
    设过.push(body);
    if (我是 !== "boss") return { 状态: 403, json: { error: "只有老板（建团队的人）能设业务主管" } };
    const b = body as { accountId: string; role: string };
    const m = 名单.find((x) => x.accountId === b.accountId && x.role !== "owner");
    if (!m) return { 状态: 404, json: { error: "这个人已经不在团队里了" } };
    m.role = b.role;
    return { 状态: 200, json: { ok: true, role: b.role } };
  }
  if (方法 === "GET" && 路径 === "/api/sync/team") return { 状态: 200, json: { ok: true, teams: [{ id: "t1xxxxxxxxxx", name: "队", active: true, 我是建的人: 我是 === "boss", 互看: 云端.互看, 成员: 名单.map((m) => ({ ...m, name: m.accountId, contact: "" })) }] } };
  return { 状态: 404, json: { error: "没有" } };
};

const ids: Record<string, string> = {};
const 任务: Record<string, string> = {};

async function 种数据() {
  for (const t of ["AuditLog", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "ContractOwner", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerPool", "CustomerClaim"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  for (const [id, name] of [[老板, "老板"], [小王, "小王"], [小李, "小李"], ["acct_gone", "走了的"]]) {
    await raw.user.create({ data: { id, email: `${id}@x.com`, name, password: "x", role: "ADMIN", active: id !== "acct_gone" } });
  }
  const 建 = async (key: string, owner: string) => {
    const c = await raw.customer.create({ data: { name: key, phone: `1390000${String(Object.keys(ids).length).padStart(4, "0")}`, salesOwnerId: owner } });
    ids[key] = c.id;
    await raw.followUp.create({ data: { customerId: c.id, ownerId: owner, type: "PHONE", title: "电话", content: `${key} 的跟进` } });
    await raw.opportunity.create({ data: { customerId: c.id, ownerId: owner, name: `${key} 的商机`, amount: 1000 } });
    任务[key] = (await raw.task.create({ data: { customerId: c.id, ownerId: owner, title: `${key} 的待办` } })).id;
  };
  await 建("小王的客户", 小王);
  await 建("小李的客户", 小李);
  await 建("老板的客户", 老板);
  await 建("公海客户", 小李);
  await raw.customerPool.create({ data: { customerId: ids["公海客户"], reason: "手动" } });
  await raw.auditLog.createMany({ data: [
    { userId: 小王, userName: "小王", action: "update", entity: "Customer", entityId: ids["小王的客户"], summary: "小王改的" },
    { userId: 小李, userName: "小李", action: "update", entity: "Customer", entityId: ids["小李的客户"], summary: "小李改的" },
  ] });
}

beforeAll(async () => {
  process.env.DESKTOP_LOCAL = "1";
  process.env.CRM_DATA_DIR = 临时.dir;
  设传输(假传输);
  await raw.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  await raw.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
  await 种数据();
  fs.writeFileSync(path.join(临时.dir, ".team.json"), JSON.stringify({ teamId: "t1xxxxxxxxxx", teamName: "队", joinSecret: "s", key: "k".repeat(43), device: "dWANG01", pulled: 0 }));
  await 当("wang");
});

afterAll(async () => {
  设传输(null);
  delete process.env.DESKTOP_LOCAL;
  delete process.env.CRM_DATA_DIR;
  忘掉限定();
  await raw.$disconnect();
  fs.rmSync(临时.dir, { recursive: true, force: true });
});

const 客户名 = async () => (await db.customer.findMany({ select: { name: true }, orderBy: { name: "asc" } })).map((c) => c.name).sort();
const 全部 = ["公海客户", "小李的客户", "小王的客户", "老板的客户"].sort();

describe("设主管", () => {
  it("业务员设不了（中继拒），本机改库也升不了：下一次对名单又改回去", async () => {
    await 当("li");
    expect(await 设角色("li", "manager")).toMatchObject({ ok: false, error: expect.stringContaining("只有老板") });
    await raw.$executeRawUnsafe(`UPDATE "User" SET role = 'MANAGER' WHERE id = ?`, 小李);
    await 当("li");
    expect(登录的.user.role).toBe("SALES");
    expect(await 限定的我(raw)).toBe(小李);
  });

  it("老板把小李设成主管：名单改了，老板这台马上对上；小李那台下次对名单就是 MANAGER", async () => {
    await 当("boss");
    expect(await 设角色("li", "manager")).toMatchObject({ ok: true, role: "manager" });
    expect(设过.at(-1)).toMatchObject({ teamId: "t1xxxxxxxxxx", accountId: "li", role: "manager" });
    expect((await raw.user.findUnique({ where: { id: 小李 } }))?.role).toBe("MANAGER");
    const 状 = await 团队状态();
    expect(状.在团队 && 状.成员.find((m) => m.accountId === "li")?.role).toBe("manager");
    await 当("li");
    expect(登录的.user.role).toBe("MANAGER");
    expect(await 团队状态()).toMatchObject({ 我是建的人: false, 我是主管: true });
  });
});

describe("主管看全部、能管客户", () => {
  it("看得到全队客户、跟进、商机、待办，不管互看开关；不是只读", async () => {
    await 当("li");
    expect(云端.互看).toBe(false);
    expect(await 限定的我(raw)).toBeNull();
    expect(await 读的我(raw)).toBeNull();
    expect(await 客户名()).toEqual(全部);
    expect(await db.followUp.count()).toBe(4);
    expect(await db.opportunity.count()).toBe(4);
    expect(await db.task.count()).toBe(4);
    expect(await 只读客户(raw, { salesOwnerId: 小王 })).toBe(false);
  });

  it("能改同事的客户（分配就是改负责人）", async () => {
    await 当("li");
    expect(await patchCustomer(ids["小王的客户"], "remark", "主管改的")).toMatchObject({ ok: true });
    expect((await raw.customer.findUnique({ where: { id: ids["小王的客户"] } }))?.remark).toBe("主管改的");
    await db.customer.update({ where: { id: ids["老板的客户"] }, data: { salesOwnerId: 小王 } });
    expect((await raw.customer.findUnique({ where: { id: ids["老板的客户"] } }))?.salesOwnerId).toBe(小王);
    await raw.customer.update({ where: { id: ids["老板的客户"] }, data: { salesOwnerId: 老板 } });
  });

  it("能把公海客户指派给业务员、能撤销", async () => {
    await 当("li");
    const id = ids["公海客户"];
    const r = await 分配公海([id], 小王);
    expect(r).toMatchObject({ ok: true, updated: 1, 给谁: { id: 小王 } });
    expect((await raw.customer.findUnique({ where: { id } }))?.salesOwnerId).toBe(小王);
    if (!r.ok) throw Error(r.error);
    expect(await 撤销公海("分配", r.原负责人!, r.带过来, 小王)).toMatchObject({ ok: true, updated: 1 });
    expect(await raw.customerPool.count({ where: { customerId: id } })).toBe(1);
  });

  it("业务员照旧：只看自己的 + 公海，指派不了", async () => {
    await 当("wang");
    expect(登录的.user.role).toBe("SALES");
    expect(await 客户名()).toEqual(["公海客户", "小王的客户"].sort());
    expect(await 分配公海([ids["公海客户"]], 小王)).toMatchObject({ ok: false, error: expect.stringContaining("只有老板和业务主管") });
    expect(await 团队状态()).toMatchObject({ 我是主管: false });
  });
});

describe("改回业务员", () => {
  it("老板改回：小李那台回到只看自己的 + 公海", async () => {
    await 当("boss");
    expect(await 设角色("li", "member")).toMatchObject({ ok: true, role: "member" });
    await 当("li");
    expect(登录的.user.role).toBe("SALES");
    expect(await 限定的我(raw)).toBe(小李);
    expect(await 客户名()).toEqual(["公海客户", "小李的客户"].sort());
    expect(await 分配公海([ids["公海客户"]], 小李)).toMatchObject({ ok: false });
  });
});
