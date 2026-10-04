/**
 * 团队版两档权限（2026-10-04：老板 / 业务员；业务员只看自己的 + 公海）。
 *   - lib/team-scope.ts：业务员的读、改、删都加限定；老板、没进团队、看全部() 里不限
 *   - lib/sync/client.ts 对齐角色：按中转的成员名单，owner = 老板（ADMIN），其余 = 业务员（SALES）
 *   - User.role 不同步：改角色不进同步日志；别人的账号同步进来默认业务员
 * 用拷出来的一份库（vi.mock 换掉 @/lib/prisma，套上和线上一样的限定层），不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-team-roles-"));
  fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(dir, "A.db"));
  if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(dir, "A.db-wal"));
  return { dir };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  const { 加上限定 } = await import("@/lib/team-scope");
  const raw = new PrismaClient({ datasourceUrl: `file:${path.join(临时.dir, "A.db")}` });
  return { prisma: 加上限定(raw), defaultClient: raw };
});

import { prisma as db, defaultClient as raw } from "@/lib/prisma";
import { 看全部, 忘掉限定, 限定的我 } from "@/lib/team-scope";
import { 设传输, 对齐角色, 退出团队, 同步一轮, type 传输 } from "@/lib/sync/client";
import { 建同步表, 装触发器, 卸触发器, 回放, 只留自己的 } from "@/lib/sync/local";
import { 带走没做完的 } from "@/lib/carry-over-db";

const 老板 = "acct_boss";
const 小王 = "acct_wang";
const 小李 = "acct_li";

let 我是 = "wang";
function 当(账号: string) {
  我是 = 账号;
  fs.writeFileSync(path.join(临时.dir, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: "dk_test", accountId: 账号, name: 账号, contact: `${账号}@x.com`, models: [], loggedAt: new Date().toISOString() }));
  忘掉限定();
}
const 团队文件 = () => path.join(临时.dir, ".team.json");
/** 多给的字段（signPriv = 建团队的那台、ownerAccountId = 上次云端说的老板）原样写进 .team.json */
const 进团队 = (多: Record<string, unknown> = {}) => { fs.writeFileSync(团队文件(), JSON.stringify({ teamId: "t1xxxxxxxxxx", teamName: "队", joinSecret: "s", key: "k".repeat(43), device: "dWANG01", pulled: 0, ...多 })); 忘掉限定(); };
const 出团队 = () => { fs.rmSync(path.join(临时.dir, ".team.json"), { force: true }); 忘掉限定(); };

const 名单 = [
  { accountId: "boss", role: "owner" },
  { accountId: "wang", role: "member" },
  { accountId: "li", role: "member" },
];
/** 云端的样子：被移出 = 我的团队列表里没有这个团了、推拉都回 403；连不上 = 什么都回 0 */
const 云端 = { 被移出: false, 连不上: false, 退队: 0 };
const 假传输: 传输 = async (方法, 路径) => {
  if (云端.连不上) return { 状态: 0, json: { error: "连不上云端，检查一下网络" } };
  if (方法 === "GET" && 路径 === "/api/sync/team") return { 状态: 200, json: { ok: true, teams: 云端.被移出 ? [] : [{ id: "t1xxxxxxxxxx", name: "队", active: true, 我是建的人: 我是 === "boss", 成员: 名单.map((m) => ({ ...m, name: m.accountId, contact: "" })) }] } };
  if (方法 === "POST" && 路径 === "/api/sync/leave") { 云端.退队++; return { 状态: 200, json: { ok: true } }; }
  if (云端.被移出) return { 状态: 403, json: { error: "你不在这个团队里" } };
  return { 状态: 404, json: { error: "没有" } };
};

const ids: Record<string, string> = {};

/** 清空、种三个人和五位客户（每位带一条跟进、商机、待办）。退出团队的用例会删数据，每条前重种一遍 */
async function 种数据() {
  for (const k of Object.keys(ids)) delete ids[k];
  for (const t of ["AiConversation", "AiProject", "Setting", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "ContractOwner", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerPool", "CustomerClaim"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  // 三个人在本机库里都是管理员（同步进来、改身份之后的样子），等 对齐角色 来定谁是业务员
  for (const [id, name] of [[老板, "老板"], [小王, "小王"], [小李, "小李"]]) {
    await raw.user.create({ data: { id, email: `${id}@x.com`, name, password: "x", role: "ADMIN" } });
  }
  const 建 = async (key: string, owner: string, extra: Record<string, unknown> = {}) => {
    const c = await raw.customer.create({ data: { name: key, phone: `1380000${String(Object.keys(ids).length).padStart(4, "0")}`, salesOwnerId: owner, ...extra } });
    ids[key] = c.id;
    await raw.followUp.create({ data: { customerId: c.id, ownerId: owner, type: "电话", title: "电话", content: `${key} 的跟进` } });
    await raw.opportunity.create({ data: { customerId: c.id, ownerId: owner, name: `${key} 的商机`, amount: 1000 } });
    await raw.task.create({ data: { customerId: c.id, ownerId: owner, title: `${key} 的待办` } });
    return c;
  };
  await 建("小王的客户", 小王);
  await 建("小李的客户", 小李);
  await 建("老板的客户", 老板);
  const 公海 = await 建("公海客户", 小李);
  await raw.customerPool.create({ data: { customerId: 公海.id, reason: "手动" } });
  // 小李负责、渠道负责人是小王：小王也看得到（归属里有他）
  await 建("小王带来的客户", 小李, { channelOwnerId: 小王 });
}

beforeAll(async () => {
  process.env.DESKTOP_LOCAL = "1";
  process.env.CRM_DATA_DIR = 临时.dir;
  设传输(假传输);
  await 种数据();
});

afterAll(async () => {
  设传输(null);
  delete process.env.DESKTOP_LOCAL;
  delete process.env.CRM_DATA_DIR;
  忘掉限定();
  await raw.$disconnect();
  fs.rmSync(临时.dir, { recursive: true, force: true });
});

beforeEach(() => 忘掉限定());

describe("对齐角色：建团队的人是老板，其余是业务员", () => {
  it("按名单改本机角色", async () => {
    当("wang");
    进团队();
    await 对齐角色();
    const 角色 = Object.fromEntries((await raw.user.findMany({ select: { id: true, role: true } })).map((u) => [u.id, u.role]));
    expect(角色).toEqual({ [老板]: "ADMIN", [小王]: "SALES", [小李]: "SALES" });
  });

  it("改角色不进同步日志（User.role 不同步）", async () => {
    await 建同步表(raw);
    await 装触发器(raw);
    try {
      const 前 = await raw.$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM _sync_log");
      await raw.$executeRawUnsafe(`UPDATE "User" SET role = 'ADMIN' WHERE id = ?`, 小李);
      await raw.$executeRawUnsafe(`UPDATE "User" SET role = 'SALES' WHERE id = ?`, 小李);
      const 后 = await raw.$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM _sync_log");
      expect(Number(后[0].n)).toBe(Number(前[0].n));
      const 行 = await raw.$queryRawUnsafe<{ row: string }[]>("SELECT row FROM _sync_log WHERE tbl = 'User' LIMIT 1");
      for (const r of 行) expect(JSON.parse(r.row)).not.toHaveProperty("role");
    } finally {
      await 卸触发器(raw);
    }
  });

  it("别人的账号同步进来（不带 role）默认是业务员", async () => {
    await 建同步表(raw);
    const 结果 = await 回放(raw, [{ t: "User", k: "acct_new", o: "I", r: { id: "acct_new", email: "new@x.com", name: "新同事", title: "销售", active: 1, createdAt: Date.now(), updatedAt: Date.now() }, c: ["id", "email", "name", "title", "active", "createdAt", "updatedAt"], h: "000000000000001-dOTHER1" }], "dWANG01");
    expect(结果, JSON.stringify(await raw.$queryRawUnsafe("SELECT why FROM _sync_skip"))).toMatchObject({ 应用: 1 });
    expect((await raw.user.findUnique({ where: { id: "acct_new" } }))?.role).toBe("SALES");
    await raw.user.delete({ where: { id: "acct_new" } });
  });
});

describe("业务员只看自己的 + 公海", () => {
  it("客户：自己负责的、渠道负责人是自己的、公海里的", async () => {
    当("wang");
    进团队();
    expect(await 限定的我(raw)).toBe(小王);
    const 名 = (await db.customer.findMany({ select: { name: true } })).map((c) => c.name).sort();
    expect(名).toEqual(["公海客户", "小王带来的客户", "小王的客户"].sort());
    expect(await db.customer.count()).toBe(3);
  });

  it("按 id 打开别人的客户：找不到（详情页 404）；改、删别人的客户：不成", async () => {
    当("wang");
    进团队();
    expect(await db.customer.findUnique({ where: { id: ids["小李的客户"] } })).toBeNull();
    expect(await db.customer.findUnique({ where: { id: ids["小王的客户"] } })).not.toBeNull();
    await expect(db.customer.update({ where: { id: ids["小李的客户"] }, data: { remark: "动了" } })).rejects.toThrow();
    expect((await db.customer.updateMany({ where: { id: ids["老板的客户"] }, data: { remark: "动了" } })).count).toBe(0);
    expect((await db.customer.deleteMany({ where: { id: ids["小李的客户"] } })).count).toBe(0);
    expect(await raw.customer.count({ where: { remark: "动了" } })).toBe(0);
  });

  it("跟进、商机、待办跟着客户走；分组统计也只算看得到的", async () => {
    当("wang");
    进团队();
    const 跟进 = (await db.followUp.findMany({ select: { content: true } })).map((f) => f.content).sort();
    expect(跟进).toEqual(["公海客户 的跟进", "小王带来的客户 的跟进", "小王的客户 的跟进"].sort());
    expect(await db.opportunity.count()).toBe(3);
    expect((await db.task.findMany({ select: { title: true } })).map((t) => t.title)).not.toContain("老板的客户 的待办");
    const 组 = await db.followUp.groupBy({ by: ["ownerId"], _count: { _all: true } });
    expect(组.map((g) => g.ownerId).sort()).toEqual([小李, 小王].sort());
  });

  it("业务员把自己的客户交给同事：客户一换人他就看不到了，商机、待办照样跟着过去（五人实测）", async () => {
    当("wang");
    进团队();
    const c = await raw.customer.create({ data: { name: "要交出去的", phone: "13900009999", salesOwnerId: 小王 } });
    await raw.opportunity.create({ data: { customerId: c.id, ownerId: 小王, name: "交出去的商机", amount: 5 } });
    await raw.task.create({ data: { customerId: c.id, ownerId: 小王, title: "交出去的待办" } });
    await db.customer.update({ where: { id: c.id }, data: { salesOwnerId: 小李 } });
    expect(await db.customer.findUnique({ where: { id: c.id } })).toBeNull();
    const 数 = await 带走没做完的([{ customerId: c.id, 旧: 小王 }], 小李);
    expect(数).toEqual({ 计划和待办: 1, 商机: 1 });
    expect((await raw.opportunity.findFirst({ where: { customerId: c.id } }))?.ownerId).toBe(小李);
    expect((await raw.task.findFirst({ where: { customerId: c.id } }))?.ownerId).toBe(小李);
  });

  it("看全部() 里不限（同步、查重用）", async () => {
    当("wang");
    进团队();
    expect(await 看全部(() => db.customer.count())).toBe(6);
  });

  it("老板看全部", async () => {
    当("boss");
    进团队();
    expect(await 限定的我(raw)).toBeNull();
    expect(await db.customer.count()).toBe(6);
    expect(await db.followUp.count()).toBe(5);
  });

  it("没进团队（一个人用）：不限", async () => {
    当("wang");
    出团队();
    expect(await db.customer.count()).toBe(6);
  });

  it("网页版 / 托管版：不限（只管桌面端本地模式）", async () => {
    当("wang");
    进团队();
    delete process.env.DESKTOP_LOCAL;
    忘掉限定();
    try {
      expect(await db.customer.count()).toBe(6);
    } finally {
      process.env.DESKTOP_LOCAL = "1";
    }
  });
});

describe("业务员离开团队：这台只留他自己的", () => {
  it("别人的客户（连同跟进、商机、待办）、公海里的、别人的操作日志都删掉；自己是销售或渠道负责人的留着；同步日志清空", async () => {
    await 建同步表(raw);
    await raw.$executeRawUnsafe("INSERT INTO _sync_log (tbl, pk, op, row, changed, at) VALUES ('Customer', 'x', 'I', '{\"name\":\"别人的整行副本\"}', '*', 1)");
    await raw.auditLog.create({ data: { userId: 小李, userName: "小李", action: "create", entity: "Customer", summary: "小李的日志" } });
    await raw.auditLog.create({ data: { userId: 小王, userName: "小王", action: "create", entity: "Customer", summary: "小王的日志" } });
    await 看全部(() => 只留自己的(raw, 小王));
    const 名 = (await raw.customer.findMany({ select: { name: true } })).map((c) => c.name).sort();
    expect(名).toEqual(["小王带来的客户", "小王的客户"].sort());
    expect(await raw.followUp.count({ where: { content: { contains: "小李的客户" } } })).toBe(0);
    expect(await raw.opportunity.count()).toBe(2);
    expect((await raw.auditLog.findMany({ select: { summary: true } })).map((a) => a.summary)).toEqual(["小王的日志"]);
    expect(Number((await raw.$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM _sync_log"))[0].n)).toBe(0);
  });
});

/*
  T-041（2026-10-04 上线前回归核对）：退出团队() 原来按本机 User.role 判是不是业务员——本机角色只是按名单对出来的副本，
  对之前（刚加入、名单没拉到）、或者被人在库里改了，都会判错：判成业务员就把老板电脑上全队的客户删了。
  现在按中转名单（云端说谁是老板）判，建团队的那台（有签名私钥）永远不删；被移出后自动退也一样。
*/
describe("退出团队：按中转名单判业务员，老板那台永远不删（T-041）", () => {
  const 客户名 = async () => (await raw.customer.findMany({ select: { name: true } })).map((c) => c.name).sort();
  const 全部五位 = ["公海客户", "小李的客户", "小王带来的客户", "小王的客户", "老板的客户"].sort();

  beforeEach(async () => {
    Object.assign(云端, { 被移出: false, 连不上: false, 退队: 0 });
    await 种数据();
  });

  it("业务员退出：只留自己的（本机角色还没对过、还是 ADMIN 也照样只留自己的）", async () => {
    当("wang");
    进团队();
    expect(await 退出团队()).toEqual({ ok: true });
    expect(云端.退队).toBe(1);
    expect(await 客户名()).toEqual(["小王带来的客户", "小王的客户"].sort());
    expect(fs.existsSync(团队文件())).toBe(false);
  });

  it("老板退出（建团队的那台）：一条不删", async () => {
    当("boss");
    进团队({ signPriv: "老板的签名私钥", ownerAccountId: "boss" });
    expect(await 退出团队()).toEqual({ ok: true });
    expect(await 客户名()).toEqual(全部五位);
    expect(await raw.followUp.count()).toBe(5);
  });

  it("本机 role 被改成 SALES 的老板：云端说他是老板，一条不删", async () => {
    当("boss");
    进团队();
    await raw.user.update({ where: { id: 老板 }, data: { role: "SALES" } });
    expect(await 退出团队()).toEqual({ ok: true });
    expect(await 客户名()).toEqual(全部五位);
    // 一个人用了：本机我回到管理员
    expect((await raw.user.findUnique({ where: { id: 老板 } }))?.role).toBe("ADMIN");
  });

  it("建团队的那台：本机角色是 SALES、云端也连不上，照样一条不删", async () => {
    当("boss");
    进团队({ signPriv: "老板的签名私钥" });
    await raw.user.update({ where: { id: 老板 }, data: { role: "SALES" } });
    云端.连不上 = true;
    expect(await 退出团队()).toEqual({ ok: true });
    expect(await 客户名()).toEqual(全部五位);
  });

  it("连不上云端、本机也没记过老板是谁：不知道就不删（本机角色是 SALES 也不算数）", async () => {
    当("wang");
    进团队();
    await raw.user.update({ where: { id: 小王 }, data: { role: "SALES" } });
    云端.连不上 = true;
    expect(await 退出团队()).toEqual({ ok: true });
    expect(await 客户名()).toEqual(全部五位);
  });

  it("连不上云端、上次名单记过老板是别人：照记下的只留自己的", async () => {
    当("wang");
    进团队();
    await 对齐角色();
    expect(JSON.parse(fs.readFileSync(团队文件(), "utf8")).ownerAccountId).toBe("boss");
    云端.连不上 = true;
    expect(await 退出团队()).toEqual({ ok: true });
    expect(await 客户名()).toEqual(["小王带来的客户", "小王的客户"].sort());
  });

  it("业务员被移出：下一轮同步自动退出、只留自己的（本机角色被改回 ADMIN 也一样）", async () => {
    当("wang");
    进团队();
    await 对齐角色();
    await raw.user.update({ where: { id: 小王 }, data: { role: "ADMIN" } });
    云端.被移出 = true;
    const r = await 同步一轮();
    expect(r).toMatchObject({ ok: false });
    await vi.waitFor(() => expect(fs.existsSync(团队文件())).toBe(false), { timeout: 3000 });
    expect(await 客户名()).toEqual(["小王带来的客户", "小王的客户"].sort());
  });

  it("建团队的那台收到「不在这个团队」：不自动退、一条不删", async () => {
    当("boss");
    进团队({ signPriv: "老板的签名私钥", ownerAccountId: "boss" });
    云端.被移出 = true;
    await 同步一轮();
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(团队文件())).toBe(true);
    expect(云端.退队).toBe(0);
    expect(await 客户名()).toEqual(全部五位);
  });
});
