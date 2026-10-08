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

// 领公海（T-040）走真的 server action：登录的人换成「当前是谁」，revalidatePath 在测试里没有请求上下文
const 登录的 = vi.hoisted(() => ({ user: { id: "acct_wang", name: "小王", email: "acct_wang@x.com", role: "SALES", title: "销售", avatar: null } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => 登录的.user }));

import { prisma as db, defaultClient as raw } from "@/lib/prisma";
import { 领取 } from "@/app/(app)/customers/pool-actions";
import { convertLead, mergeLeadInto } from "@/app/(app)/leads/actions";
import { checkDuplicate, saveCustomer } from "@/app/(app)/customers/actions";
import { 疑似重复 } from "@/lib/sync/dupes";
import { 看全部, 忘掉限定, 限定的我 } from "@/lib/team-scope";
import { 设传输, 对齐角色, 退出团队, 同步一轮, type 传输 } from "@/lib/sync/client";
import { 建同步表, 装触发器, 卸触发器, 回放, 只留自己的 } from "@/lib/sync/local";
import { 带走没做完的 } from "@/lib/carry-over-db";
import { TOOL_MAP, type ToolContext } from "@/lib/agent/tools";
import { getBusiness } from "@/lib/business";
import { 订单详情 } from "@/lib/order-db";
import { MCP_TOOL_NAMES, 跑工具 } from "@/lib/mcp/tools";
import ContactsPage from "@/app/(app)/contacts/page";

const 老板 = "acct_boss";
const 小王 = "acct_wang";
const 小李 = "acct_li";

it("J-017 按原客户名搜索未归属联系人仍受业务员权限限定", async () => {
  await raw.unassignedContact.createMany({ data: [
    { id: "search-own", name: "我的原联系人", fromCustomerName: "共同原公司", ownerId: 小王, wasPrimary: true },
    { id: "search-hidden", name: "同事原联系人", fromCustomerName: "共同原公司", ownerId: 小李, wasPrimary: true },
  ] });
  try {
    当("wang"); 进团队(); await 对齐角色();
    const page = await ContactsPage({ searchParams: Promise.resolve({ keyword: "共同原公司" }) });
    expect(page.props.总数).toBe(1); expect(page.props.rows.map((r: { id: string }) => r.id)).toEqual(["search-own"]);
  } finally { await raw.unassignedContact.deleteMany({ where: { id: { in: ["search-own", "search-hidden"] } } }); }
});

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
  it("旁表的必填关联也不能绕过客户范围读取原文与签约归属", async () => {
    const follow = await raw.followUp.findFirstOrThrow({ where: { customerId: ids["小李的客户"] } });
    const contract = await raw.contract.create({ data: { customerId: ids["小李的客户"], amount: 987, signedAt: new Date() } });
    await raw.followUpSource.create({ data: { followUpId: follow.id, text: "同事私有对话" } });
    await raw.contractOwner.create({ data: { contractId: contract.id, salesOwnerId: 小李 } });
    try {
      当("wang"); 进团队();
      expect(await db.followUpSource.findMany({ include: { followUp: { include: { customer: true } } } })).toEqual([]);
      expect(await db.contractOwner.findMany({ include: { contract: { include: { customer: true } } } })).toEqual([]);
      当("boss");
      expect(await db.followUpSource.count()).toBe(1);
      expect(await db.contractOwner.count()).toBe(1);
    } finally {
      await raw.followUpSource.delete({ where: { followUpId: follow.id } });
      await raw.contract.delete({ where: { id: contract.id } });
      当("wang");
    }
  });

  it("旧客户端移出联系人后删除来源客户，联系人仍有归属且回放不产生回声", async () => {
    const c = await raw.customer.create({ data: { name: "旧版移出来源", phone: "13000008888", salesOwnerId: 小王 } });
    const id = "legacy-detached-owner";
    await 建同步表(raw);
    await 装触发器(raw);
    try {
      const before = await raw.$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM _sync_log");
      const row = { id, name: "旧版联系人", fromCustomerId: c.id, createdAt: Date.now(), updatedAt: Date.now() };
      const result = await 回放(raw, [
        { t: "UnassignedContact", k: id, o: "I", r: row, c: Object.keys(row), h: "999999999999970-dLEGACY1" },
        { t: "Customer", k: c.id, o: "D", r: {}, c: [], h: "999999999999971-dLEGACY1" },
      ], "dWANG01");
      expect(result, JSON.stringify(await raw.$queryRawUnsafe("SELECT why FROM _sync_skip"))).toMatchObject({ 跳: 0 });
      expect(await raw.customer.findUnique({ where: { id: c.id } })).toBeNull();
      expect(await raw.unassignedContact.findUnique({ where: { id } })).toMatchObject({ ownerId: 小王 });
      const after = await raw.$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM _sync_log");
      expect(after[0].n).toBe(before[0].n);
      当("wang"); 进团队();
      expect(await db.unassignedContact.findUnique({ where: { id } })).not.toBeNull();
      当("li");
      expect(await db.unassignedContact.findUnique({ where: { id } })).toBeNull();
    } finally {
      await 卸触发器(raw);
      await raw.unassignedContact.deleteMany({ where: { id } });
      await raw.customer.deleteMany({ where: { id: c.id } });
      当("wang");
    }
  });

  it("可空关联及递归计数也过滤，保留调用方筛选；老板仍可看全部", async () => {
    const own = ids["小王的客户"], hidden = ids["小李的客户"];
    await raw.customer.update({ where: { id: own }, data: { referrerCustomerId: hidden } });
    try {
      当("wang"); 进团队();
      expect(await db.customer.findUnique({ where: { id: own }, include: { referrerCustomer: true } })).toMatchObject({ referrerCustomer: null });
      const li = await db.user.findUniqueOrThrow({ where: { id: 小李 }, include: { _count: true } });
      expect(li._count.salesCustomers).toBe(2); // 公海 + 小王是渠道负责人
      const filtered = await db.user.findUniqueOrThrow({ where: { id: 小李 }, select: { salesCustomers: { where: { name: "小李的客户" } }, _count: { select: { salesCustomers: { where: { name: "小李的客户" } } } } } });
      expect(filtered).toEqual({ salesCustomers: [], _count: { salesCustomers: 0 } });
      当("boss");
      expect(await db.customer.findUnique({ where: { id: own }, include: { referrerCustomer: true } })).toMatchObject({ referrerCustomer: { id: hidden } });
    } finally {
      await raw.customer.update({ where: { id: own }, data: { referrerCustomerId: null } });
      当("wang");
    }
  });

  it("热缓存遇到凭据丢失仍拒绝；不存在或停用的团队身份不能变成老板", async () => {
    当("wang"); 进团队();
    expect(await db.customer.count()).toBe(3);
    fs.rmSync(path.join(临时.dir, ".cloud.json"));
    await expect(db.customer.count()).rejects.toThrow("团队身份缺失");
    当("missing-account");
    await expect(db.customer.count()).rejects.toThrow("团队身份不存在或已停用");
    当("wang");
    await raw.user.update({ where: { id: 小王 }, data: { active: false } });
    try { await expect(db.customer.count()).rejects.toThrow("团队身份不存在或已停用"); }
    finally { await raw.user.update({ where: { id: 小王 }, data: { active: true } }); 忘掉限定(); }
  });

  it("审计补测：未归属联系人不泄漏同事记录，也不能按 id 修改", async () => {
    const 自己 = "audit-unassigned-wang";
    const 同事 = "audit-unassigned-li";
    await raw.unassignedContact.createMany({ data: [
      { id: 自己, name: "自己移出的联系人", fromCustomerId: ids["小王的客户"], ownerId: 小王 },
      { id: 同事, name: "同事私有联系人", phone: "13999990000", fromCustomerId: ids["小李的客户"], ownerId: 小李 },
    ] });
    try {
      当("wang"); 进团队();
      expect((await db.unassignedContact.findMany()).map((x) => x.id)).toEqual([自己]);
      expect(await db.unassignedContact.findUnique({ where: { id: 同事 } })).toBeNull();
      expect((await db.unassignedContact.updateMany({ where: { id: 同事 }, data: { remark: "越权" } })).count).toBe(0);
    } finally {
      await raw.unassignedContact.deleteMany({ where: { id: { in: [自己, 同事] } } });
    }
  });

  it("审计补测：AI 渠道汇总只计算可见客户及其签约额", async () => {
    const 渠道 = await raw.channel.create({ data: { name: "审计共享渠道", channelOwnerId: 老板 } });
    await raw.customer.updateMany({ where: { id: { in: [ids["小王的客户"], ids["小李的客户"]] } }, data: { channelId: 渠道.id } });
    const 签约 = await raw.contract.createMany({ data: [
      { customerId: ids["小王的客户"], amount: 123, signedAt: new Date() },
      { customerId: ids["小李的客户"], amount: 987654, signedAt: new Date() },
    ] });
    void 签约;
    try {
      当("wang"); 进团队();
      const ctx: ToolContext = { userId: 小王, userName: "小王", b: await getBusiness(), recordOffset: 0, proposals: [] };
      const r = await TOOL_MAP.get("list_channels")!.run({ keyword: "审计共享渠道" }, ctx);
      expect(r.data).toMatchObject([{ 直接带来: 1, 连转介绍一共: 1 }]);
      expect(JSON.stringify(r.data)).not.toContain("987,777");
    } finally {
      await raw.contract.deleteMany({ where: { amount: { in: [123, 987654] } } });
      await raw.customer.updateMany({ where: { channelId: 渠道.id }, data: { channelId: null } });
      await raw.channel.delete({ where: { id: 渠道.id } });
    }
  });

  it("审计补测：AI 成员客户数不能透露私有客户数量", async () => {
    当("wang"); 进团队();
    const ctx: ToolContext = { userId: 小王, userName: "小王", b: await getBusiness(), recordOffset: 0, proposals: [] };
    const r = await TOOL_MAP.get("list_users")!.run({ keyword: "老板" }, ctx);
    expect(r.data).toMatchObject([{ 姓名: "老板", 负责客户: 0 }]);
  });

  it("审计补测：仍在团队但凭据丢失时，不能放宽成全队可见", async () => {
    当("wang"); 进团队();
    fs.rmSync(path.join(临时.dir, ".cloud.json"));
    忘掉限定();
    try {
      let 可见: number;
      try { 可见 = await db.customer.count(); } catch { return; } // 拒绝读取也是安全结果
      expect(可见).toBeLessThanOrEqual(3);
    } finally { 当("wang"); }
  });

  it("客户：自己负责的、渠道负责人是自己的、公海里的", async () => {
    当("wang");
    进团队();
    expect(await 限定的我(raw)).toBe(小王);
    const 名 = (await db.customer.findMany({ select: { name: true } })).map((c) => c.name).sort();
    expect(名).toEqual(["公海客户", "小王带来的客户", "小王的客户"].sort());
    expect(await db.customer.count()).toBe(3);
  });

  it("订单（2026-10-05 打开）：订单一览、外贸档案、订单上的跟进，业务员只看得到自己客户的", async () => {
    for (const [k, owner] of [["小王的客户", 小王], ["小李的客户", 小李]] as const) {
      const o = await raw.tradeOrder.create({ data: { no: `PI-${k}`, customerId: ids[k], ownerId: owner, amount: 1, currency: "USD" } });
      await raw.customerExtra.create({ data: { customerId: ids[k], country: "美国" } });
      const f = await raw.followUp.findFirstOrThrow({ where: { customerId: ids[k] } });
      await raw.followUpOrder.create({ data: { followUpId: f.id, orderId: o.id, nodeIdx: 0 } });
    }
    try {
      当("wang");
      进团队();
      expect((await db.tradeOrder.findMany({ select: { no: true } })).map((x) => x.no)).toEqual(["PI-小王的客户"]);
      expect(await db.customerExtra.count()).toBe(1);
      expect(await db.followUpOrder.count()).toBe(1);
      出团队();
      expect(await db.tradeOrder.count()).toBe(2);
    } finally {
      await raw.tradeOrder.deleteMany();
      await raw.customerExtra.deleteMany();
    }
  });

  it("供应商（2026-10-06 复查）：业务员打开一家供应商，只看到自己客户的比价和订单，看不到同事客户的名字", async () => {
    const 厂 = await raw.supplier.create({ data: { name: "共用的厂" } });
    for (const [k, owner] of [["小王的客户", 小王], ["小李的客户", 小李]] as const) {
      const o = await raw.tradeOrder.create({ data: { no: `S-${k}`, customerId: ids[k], ownerId: owner } });
      await raw.tradeOrderPurchase.create({ data: { orderId: o.id, supplierId: 厂.id } });
      const 商机 = await raw.opportunity.findFirstOrThrow({ where: { customerId: ids[k] } });
      await raw.supplierQuote.create({ data: { opportunityId: 商机.id, supplierId: 厂.id, product: `${k} 的货` } });
    }
    try {
      const { 供应商详情, 供应商列表 } = await import("@/lib/supplier-db");
      当("wang");
      进团队();
      const 详 = await 供应商详情(厂.id);
      expect(详?.purchases.map((p) => p.客户)).toEqual(["小王的客户"]);
      expect(详?.quotes.map((q) => q.客户)).toEqual(["小王的客户"]);
      expect((await 供应商列表()).find((x) => x.id === 厂.id)).toMatchObject({ 比价: 1, 合作单数: 1 });
      出团队();
      expect((await 供应商详情(厂.id))?.purchases).toHaveLength(2);
    } finally {
      await raw.tradeOrder.deleteMany();
      await raw.supplier.deleteMany();
    }
  });

  it("二审：业务员在编辑框里把客户交给同事、同时改了 WhatsApp——保存成功，其余档案格不被清掉", async () => {
    const id = ids["小王的客户"];
    await raw.customerExtra.upsert({ where: { customerId: id }, create: { customerId: id, country: "美国", email: "a@b.com" }, update: { country: "美国", email: "a@b.com" } });
    const 现 = await raw.customer.findUniqueOrThrow({ where: { id } });
    const 起 = new Date();
    try {
      当("wang");
      进团队();
      登录的.user = { ...登录的.user, id: 小王 };
      const r = await saveCustomer({
        id, updatedAt: 现.updatedAt.toISOString(), name: 现.name, phone: 现.phone, school: null, grade: null, major: null,
        followStatus: 现.followStatus, decisionStatus: 现.decisionStatus, expectedSignAt: null, remark: null,
        salesOwnerId: 小李, channelId: null, referrerCustomerId: null, extra: { whatsapp: "+1 415 555 0101" },
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(await raw.customerExtra.findUniqueOrThrow({ where: { customerId: id } })).toMatchObject({ country: "美国", email: "a@b.com", whatsapp: "+1 415 555 0101" });
    } finally {
      await raw.customer.update({ where: { id }, data: { salesOwnerId: 小王 } });
      await raw.customerExtra.deleteMany();
      await raw.auditLog.deleteMany({ where: { at: { gte: 起 } } }); // 后面的用例数日志条数
      登录的.user = { ...登录的.user, id: "acct_wang" };
    }
  });

  it("回归核对 W-041 / W-048 / W-010：订单节点、单据按客户限定；AI 列供应商只带自己客户的比价；业务员编的默认订单号不撞同事看不到的单", async () => {
    const 厂 = await raw.supplier.create({ data: { name: "共用的厂2" } });
    const 今 = new Date();
    const 日 = `${今.getFullYear()}${String(今.getMonth() + 1).padStart(2, "0")}${String(今.getDate()).padStart(2, "0")}`;
    for (const [k, owner] of [["小王的客户", 小王], ["小李的客户", 小李]] as const) {
      // 小李那张单的号就是今天的第 1 号：小王看不到它，但编号时不能再编出同一个号
      const o = await raw.tradeOrder.create({ data: { no: owner === 小李 ? `${日}-1` : `N-${k}`, customerId: ids[k], ownerId: owner, nodes: { create: [{ idx: 1, name: "询盘" }] }, docs: { create: [{ name: "PI", sort: 0 }] } } });
      void o;
      const 商机 = await raw.opportunity.findFirstOrThrow({ where: { customerId: ids[k] } });
      await raw.supplierQuote.create({ data: { opportunityId: 商机.id, supplierId: 厂.id, product: `${k} 的货` } });
    }
    try {
      当("wang");
      进团队();
      expect(await db.tradeOrderNode.count()).toBe(1);
      expect(await db.tradeOrderDoc.count()).toBe(1);
      const ctx = { userId: 小王, userName: "小王", b: await getBusiness(), recordOffset: 0, proposals: [] } as unknown as ToolContext;
      const 出 = await TOOL_MAP.get("list_suppliers")!.run({ keyword: "共用的厂2" }, ctx);
      const 比价 = JSON.stringify(出.data);
      expect(比价).toContain("小王的客户");
      expect(比价).not.toContain("小李的客户");
      const { 写签约的订单 } = await import("@/lib/order-contract");
      const k = await raw.contract.create({ data: { customerId: ids["小王的客户"], amount: 1, signedAt: 今 } });
      const 单 = await db.$transaction((tx) => 写签约的订单(tx, { 签约id: k.id, customerId: ids["小王的客户"], ownerId: 小王, amount: 1, currency: "USD", 附加: {} }));
      expect(单?.no).toBe(`${日}-2`);
    } finally {
      出团队();
      await raw.tradeOrder.deleteMany();
      await raw.contract.deleteMany({ where: { customerId: ids["小王的客户"], amount: 1 } });
      await raw.supplier.deleteMany();
    }
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

  /*
    上线前测试 4.2「AI 回答只有自己的 + 公海」：AI 的工具读库走的是同一个 prisma（限定层在 Prisma 上），
    这里把问 AI 时最常用的几把工具挨个跑一遍——找客户、按名字读客户、搜跟进、列商机、盯盘——答出来的只有看得到的
  */
  it("订单的其余出口（测试分期 E.4）：AI 列订单、按订单号找客户、按 id 开同事的订单详情、MCP，业务员都只拿到自己客户的", async () => {
    for (const [k, owner] of [["小王的客户", 小王], ["小李的客户", 小李]] as const) {
      await raw.tradeOrder.create({ data: { no: `PI-${k}`, customerId: ids[k], ownerId: owner, amount: 1, currency: "USD" } });
    }
    const 李单 = await raw.tradeOrder.findFirstOrThrow({ where: { no: "PI-小李的客户" } });
    try {
      当("wang");
      进团队();
      const ctx: ToolContext = { userId: 小王, userName: "小王", b: await getBusiness(), recordOffset: 0, proposals: [] };
      const 跑 = async (名: string, args: Record<string, unknown>) => JSON.stringify((await TOOL_MAP.get(名)!.run(args, ctx)).data);
      const 列 = await 跑("list_orders", {});
      expect(列).toContain("PI-小王的客户");
      expect(列, "AI 列订单").not.toContain("小李的客户");
      // 订单号这条路是 C.2 新加的：报同事的 PI 号也不能把那位客户带出来
      expect(await 跑("search_customers", { query: "PI-小李" }), "按订单号找客户").not.toContain("小李的客户");
      expect(await 跑("search_customers", { query: "PI-小王" })).toContain("小王的客户");
      expect(await 订单详情(李单.id), "按 id 直接开同事的订单").toBeNull();
      expect(MCP_TOOL_NAMES).toContain("list_orders");
      const mcp = JSON.stringify(await 跑工具("list_orders", {}, { id: 小王, name: "小王" }));
      expect(mcp).toContain("PI-小王的客户");
      expect(mcp, "MCP 列订单").not.toContain("小李的客户");
    } finally {
      出团队();
      await raw.tradeOrder.deleteMany();
    }
  });

  it("AI 的工具也只答看得到的：找客户、读别人的客户、搜跟进、列商机、盯盘都没有同事的", async () => {
    当("wang");
    进团队();
    const ctx: ToolContext = { userId: 小王, userName: "小王", b: await getBusiness(), recordOffset: 0, proposals: [] };
    const 跑 = async (名: string, args: Record<string, unknown>) => JSON.stringify((await TOOL_MAP.get(名)!.run(args, ctx)).data);
    const 同事的 = ["小李的客户", "老板的客户"];

    const 找 = await 跑("search_customers", { query: "客户" });
    for (const n of ["小王的客户", "公海客户", "小王带来的客户"]) expect(找, `找客户里该有「${n}」`).toContain(n);
    for (const n of 同事的) expect(找, `找客户里不该有「${n}」`).not.toContain(n);

    // 按名字点名要别人的客户：当作没有这个人，不把记录读出来
    for (const n of 同事的) {
      const 读 = await 跑("get_customer", { name: n });
      expect(读, `get_customer「${n}」`).not.toContain(`${n} 的跟进`);
      expect(读).not.toContain("13800000");
    }
    const 读按id = await 跑("get_customer", { id: ids["老板的客户"] });
    expect(读按id).not.toContain("老板的客户 的跟进");

    const 跟进 = await 跑("search_followups", { keyword: "跟进" });
    expect(跟进).toContain("小王的客户 的跟进");
    for (const n of 同事的) expect(跟进, "搜跟进").not.toContain(`${n} 的跟进`);

    const 商机 = await 跑("list_opportunities", {});
    expect(商机).toContain("小王的客户 的商机");
    for (const n of 同事的) expect(商机, "列商机").not.toContain(`${n} 的商机`);

    const 盯 = await 跑("get_watchlist", {});
    for (const n of 同事的) expect(盯, "盯盘").not.toContain(n);
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
  T-040（2026-10-04 上线前回归核对）：业务员领公海。领取的事务里先删公海那一行、再改负责人——删完那一刻客户在业务员眼里
  「不见了」，限定着读会读回 null：客户出了公海、却没归任何人（五人实测栽过）。全靠 pool-actions 里那层 看全部() 兜着，
  原来没有一条用例走限定层领取
*/
describe("业务员在限定视图下领公海（T-040）", () => {
  beforeEach(async () => {
    Object.assign(云端, { 被移出: false, 连不上: false, 退队: 0 });
    await 种数据();
  });

  it("小王领「公海客户」：负责人变小王、公海行没了、小李在他身上没做完的活过来、领完看得到", async () => {
    当("wang");
    进团队();
    await 对齐角色();
    expect(await 限定的我(raw)).toBe(小王);
    const id = ids["公海客户"];
    const r = await 领取([id]);
    expect(r).toMatchObject({ ok: true, updated: 1, 带走: { 计划和待办: 1, 商机: 1 } });
    expect((await raw.customer.findUnique({ where: { id } }))?.salesOwnerId).toBe(小王);
    expect(await raw.customerPool.count({ where: { customerId: id } })).toBe(0);
    expect((await raw.task.findFirst({ where: { customerId: id } }))?.ownerId).toBe(小王);
    expect((await raw.opportunity.findFirst({ where: { customerId: id } }))?.ownerId).toBe(小王);
    // 领完在小王的限定视图里还看得到（现在是他负责的了）
    忘掉限定();
    expect(await db.customer.findUnique({ where: { id } })).not.toBeNull();
    expect((await db.task.findMany({ select: { title: true } })).map((t) => t.title)).toContain("公海客户 的待办");
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
    // 退出团队先删 .team.json、再「只留自己的」：文件没了不等于删完了（10-07 Windows 打包机慢，在这两步中间查到了五位）
    await vi.waitFor(async () => expect(await 客户名()).toEqual(["小王带来的客户", "小王的客户"].sort()), { timeout: 3000 });
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

/*
  J-024（2026-10-04 工作室试用前）：线索的电话已经是某位客户的（同事的也算），转客户只报「请勿重复建档」，
  没有路走，这条线索永远转不了。现在：说清撞的是谁（业务员撞到同事的只给名字和负责人），
  看得到那位客户的人可以「并到这位客户」——线索标成已转化、关联过去，不另建档案；看不到的并不了，指路找负责人或老板。
*/
describe("线索撞了已有客户的号：说清是谁、能并过去（J-024）", () => {
  const 号 = async (客户: string) => (await raw.customer.findUniqueOrThrow({ where: { id: ids[客户] } })).phone;
  const 建线索 = async (名: string, phone: string, ownerId = 小王) => (await raw.lead.create({ data: { name: 名, phone, ownerId } })).id;
  const 小王登录 = { ...登录的.user };

  beforeEach(async () => {
    Object.assign(云端, { 被移出: false, 连不上: false, 退队: 0 });
    await 种数据();
    当("wang");
    进团队();
    await 对齐角色();
    登录的.user = { ...小王登录 };
  });

  it("撞自己的客户：说出是谁、给出能并；并过去 → 线索已转化、关联到那位，不多建一份档案", async () => {
    const lead = await 建线索("又来了一次", await 号("小王的客户"));
    const r = await convertLead(lead);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("小王的客户");
    expect(r.撞号).toMatchObject({ 客户名: "小王的客户", 负责人: "小王", customerId: ids["小王的客户"], 能并: true });
    const m = await mergeLeadInto(lead, ids["小王的客户"]);
    expect(m).toMatchObject({ ok: true, customerId: ids["小王的客户"] });
    const 线索 = await raw.lead.findUniqueOrThrow({ where: { id: lead } });
    expect(线索.status).toBe("已转化");
    expect(线索.customerId).toBe(ids["小王的客户"]);
    expect(线索.convertedAt).not.toBeNull();
    expect(await raw.customer.count()).toBe(5);
    // 再并一次：已经转化过了
    expect((await mergeLeadInto(lead, ids["小王的客户"])).ok).toBe(false);
  });

  it("业务员撞到同事的客户：只给负责人（不给名字、不给 id）、不能并，指路找负责人或老板；硬并也不成", async () => {
    const lead = await 建线索("同事的人", await 号("小李的客户"));
    const r = await convertLead(lead);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // 10-04 用户拍板：同事客户的名字也不给（原来给名字和负责人）
    expect(r.撞号).toEqual({ 客户名: null, 负责人: "小李", customerId: null, 能并: false });
    expect(r.error).not.toContain("小李的客户");
    expect(r.error).toContain("小李");
    expect(r.error).toContain("老板");
    const m = await mergeLeadInto(lead, ids["小李的客户"]);
    expect(m.ok).toBe(false);
    const 线索 = await raw.lead.findUniqueOrThrow({ where: { id: lead } });
    expect(线索.status).toBe("待跟进");
    expect(线索.customerId).toBeNull();
  });

  it("老板撞到业务员的客户：能并", async () => {
    当("boss");
    进团队();
    登录的.user = { id: 老板, name: "老板", email: `${老板}@x.com`, role: "ADMIN", title: "老板", avatar: null };
    const lead = await 建线索("业务员的人", await 号("小李的客户"), 小王);
    const r = await convertLead(lead);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.撞号).toMatchObject({ customerId: ids["小李的客户"], 能并: true });
    expect((await mergeLeadInto(lead, ids["小李的客户"])).ok).toBe(true);
    expect((await raw.lead.findUniqueOrThrow({ where: { id: lead } })).customerId).toBe(ids["小李的客户"]);
  });

  it("电话对不上的客户不让并（只能并到撞号的那位）", async () => {
    const lead = await 建线索("对不上", await 号("小王的客户"));
    const m = await mergeLeadInto(lead, ids["小王带来的客户"]);
    expect(m.ok).toBe(false);
    expect((await raw.lead.findUniqueOrThrow({ where: { id: lead } })).status).toBe("待跟进");
  });

  it("那位客户已经关联着另一条线索（同一个人从两个渠道来）：照样能并，线索标已转化、备注写明并到了谁", async () => {
    const 先 = await 建线索("先来的", await 号("小王的客户"));
    await raw.lead.update({ where: { id: 先 }, data: { customerId: ids["小王的客户"], status: "已转化" } });
    const lead = await 建线索("后来的", await 号("小王的客户"));
    expect(await mergeLeadInto(lead, ids["小王的客户"])).toMatchObject({ ok: true, customerId: ids["小王的客户"] });
    const 线索 = await raw.lead.findUniqueOrThrow({ where: { id: lead } });
    expect(线索.status).toBe("已转化");
    expect(线索.remark).toContain("小王的客户");
    // 原来那条的关联不动
    expect((await raw.lead.findUniqueOrThrow({ where: { id: 先 } })).customerId).toBe(ids["小王的客户"]);
  });
});

/*
  10-04 用户拍板：业务员录到同事名下已有的号码，提示里**不露那位客户是谁**（原来给名字和负责人），只说是哪位同事在跟。
  一起查出来的两处：编辑时把号码改成同事客户的号，原来只看得到自己的、查不出来，悄悄存成两份同号档案；
  团队设置里的「疑似重复」号码是裸 SQL 查的、不过限定，两条都是同事的那组记录是空的、号码却摆给了业务员。
*/
describe("撞号不露同事的客户（10-04）", () => {
  const 号 = async (客户: string) => (await raw.customer.findUniqueOrThrow({ where: { id: ids[客户] } })).phone;
  const 小王登录 = { ...登录的.user };
  const 表单 = (phone: string, 补: Record<string, unknown> = {}) => ({
    name: "新来的", phone, school: null, grade: null, major: null, followStatus: "待跟进",
    decisionStatus: "了解中", expectedSignAt: null, remark: null, salesOwnerId: 小王, channelId: null, referrerCustomerId: null, ...补,
  });

  beforeEach(async () => {
    Object.assign(云端, { 被移出: false, 连不上: false, 退队: 0 });
    await 种数据();
    当("wang");
    进团队();
    await 对齐角色();
    登录的.user = { ...小王登录 };
  });

  it("表单失焦查重：撞同事的只给负责人，id / 名字 / 学校都是空；撞自己的照常给名字", async () => {
    const 同事 = await checkDuplicate(await 号("小李的客户"));
    expect(同事).toMatchObject({ id: null, name: null, school: null, salesOwnerName: "小李" });
    const 自己 = await checkDuplicate(await 号("小王的客户"));
    expect(自己).toMatchObject({ id: ids["小王的客户"], name: "小王的客户", salesOwnerName: "小王" });
  });

  it("新建时撞同事的：挡下，话里只有负责人，没有客户名", async () => {
    const r = await saveCustomer(表单(await 号("小李的客户")) as Parameters<typeof saveCustomer>[0]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).not.toContain("小李的客户");
    expect(r.error).toContain("小李");
    expect(await raw.customer.count()).toBe(5);
  });

  it("编辑时把号码改成同事客户的号：挡下（原来查不出来、存成两份同号），话里不露客户名", async () => {
    const 我的 = await raw.customer.findUniqueOrThrow({ where: { id: ids["小王的客户"] } });
    const r = await saveCustomer(表单(await 号("小李的客户"), { id: 我的.id, name: 我的.name, updatedAt: 我的.updatedAt.toISOString() }) as Parameters<typeof saveCustomer>[0]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).not.toContain("小李的客户");
    expect((await raw.customer.findUniqueOrThrow({ where: { id: 我的.id } })).phone).toBe(我的.phone);
  });

  it("疑似重复：两条都是同事的那组，业务员这里不列（号码也不露）；老板照样看得到", async () => {
    const 李的号 = await 号("小李的客户");
    await raw.customer.create({ data: { name: "小李又录了一次", phone: 李的号, salesOwnerId: 小李 } });
    expect((await 疑似重复()).filter((g) => g.依据.includes(李的号))).toEqual([]);
    当("boss");
    进团队();
    await 对齐角色();
    const 老板看 = (await 疑似重复()).filter((g) => g.依据.includes(李的号));
    expect(老板看).toHaveLength(1);
    expect(老板看[0].记录.map((r) => r.name).sort()).toEqual(["小李又录了一次", "小李的客户"]);
  });
});
