/**
 * 企业版「按组织架构看客户」（lib/enterprise/visibility.ts + team-scope 加上限定）。
 * 钉的是：规则关着 = 照旧看全部；开了以后销售只看自己的和公海，直属上级看、改整条下属链，
 * 虚线上级只能看（改、转、在下面加跟进都拦）；老板、总管理员看全部；没认出人只看公海；后台任务不限定。
 * 用拷出来的一份库、显式单连接，不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-ent-vis-"));
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
import { 以谁的身份, 忘掉企业版范围, 组织范围of } from "@/lib/enterprise/visibility";
import { 建组织 } from "@/lib/enterprise/org-core";
import { 只读客户, 读的我, 限定条件, 看得到 } from "@/lib/team-scope";
import { 规则 } from "@/lib/enterprise/rules";

const 老板 = "e_boss";
const 总管 = "e_dir";
const 经理 = "e_mgr";
const 小王 = "e_wang"; // 经理的实线下属
const 小张 = "e_zhang"; // 经理的虚线下属
const 小赵 = "e_zhao"; // 小张的实线下属（经理虚线链上）
const 外人 = "e_other";

const 名单 = async () => (await db.customer.findMany({ orderBy: { name: "asc" } })).map((c) => c.name);
const 作为 = <T,>(id: string, f: () => Promise<T>) => 以谁的身份(id, f);
const 客户id = async (name: string) => (await raw.customer.findFirstOrThrow({ where: { name } })).id;
const 开规则 = async (on: boolean) => {
  await raw.setting.upsert({ where: { key: 规则.按组织看客户.key }, update: { value: JSON.stringify(on) }, create: { key: 规则.按组织看客户.key, value: JSON.stringify(on) } });
  忘掉企业版范围();
};

beforeAll(async () => {
  process.env.CRM_ENTERPRISE = "1";
  delete process.env.DESKTOP_LOCAL;
  for (const t of ["AiConversation", "AiProject", "Setting", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "ContractOwner", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerPool", "CustomerClaim", "EntMember", "EntDept"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  const 人 = (id: string, name: string, role = "SALES") => raw.user.create({ data: { id, email: `${id}@x.com`, name, password: "x", role } });
  await 人(老板, "老板", "ADMIN");
  for (const [id, n] of [[总管, "总管"], [经理, "经理"], [小王, "小王"], [小张, "小张"], [小赵, "小赵"], [外人, "外人"]]) await 人(id, n);
  await raw.entMember.createMany({
    data: [
      { userId: 总管, bizRole: "director" },
      { userId: 经理, bizRole: "sales_mgr" },
      { userId: 小王, managerId: 经理 },
      { userId: 小张, dottedManagerId: 经理 },
      { userId: 小赵, managerId: 小张 },
      { userId: 外人 },
    ],
  });
  for (const [n, o] of [["A经理的", 经理], ["B小王的", 小王], ["C小张的", 小张], ["D小赵的", 小赵], ["E外人的", 外人], ["F老板的", 老板]] as const)
    await raw.customer.create({ data: { name: n, phone: `1380000${n.charCodeAt(0)}`, salesOwnerId: o } });
  const 公海 = await raw.customer.create({ data: { name: "G公海", phone: "13800009999", salesOwnerId: 老板 } });
  await raw.customerPool.create({ data: { customerId: 公海.id } });
});

beforeEach(() => 忘掉企业版范围());

afterAll(async () => {
  delete process.env.CRM_ENTERPRISE;
  忘掉企业版范围();
  await raw.$disconnect();
  fs.rmSync(临时.dir, { recursive: true, force: true });
});

describe("组织范围of（纯函数）", () => {
  const org = () =>
    建组织(
      [老板, 总管, 经理, 小王, 小张, 小赵, 外人].map((id) => ({ id, role: id === 老板 ? "ADMIN" : "SALES", active: true })),
      [
        { userId: 总管, deptId: null, bizRole: "director", line: null, managerId: null, dottedManagerId: null },
        { userId: 小王, deptId: null, bizRole: "sales", line: null, managerId: 经理, dottedManagerId: null },
        { userId: 小张, deptId: null, bizRole: "sales", line: null, managerId: null, dottedManagerId: 经理 },
        { userId: 小赵, deptId: null, bizRole: "sales", line: null, managerId: 小张, dottedManagerId: null },
      ],
      [],
    );
  it("老板、总管理员 = 看全部", () => {
    expect(组织范围of(org(), "ADMIN", 老板)).toBeNull();
    expect(组织范围of(org(), "SALES", 总管)).toBeNull();
  });
  it("经理：改 = 自己 + 实线下属；看再加虚线下属和他的实线下属", () => {
    const r = 组织范围of(org(), "SALES", 经理)!;
    expect([...r.写].sort()).toEqual([经理, 小王].sort());
    expect([...r.读!].sort()).toEqual([经理, 小王, 小张, 小赵].sort());
  });
  it("普通销售只有自己，读和写一样就不带 读；不在组织里的人什么都没有", () => {
    expect(组织范围of(org(), "SALES", 外人)).toEqual({ 写: [外人] });
    expect(组织范围of(org(), "SALES", "nobody")).toEqual({ 写: ["__无"] });
  });
});

describe("限定条件 / 看得到 支持一组人，单人的写法不变", () => {
  it("单人照旧是等于，一组人是 in", () => {
    expect(JSON.stringify(限定条件("Customer", "u1"))).toContain('"salesOwnerId":"u1"');
    expect(JSON.stringify(限定条件("Customer", ["u1", "u2"]))).toContain('"salesOwnerId":{"in":["u1","u2"]}');
  });
  it("看得到：数组里任一个是负责人、或在公海", () => {
    expect(看得到({ salesOwnerId: "u2" }, ["u1", "u2"])).toBe(true);
    expect(看得到({ salesOwnerId: "u3" }, ["u1", "u2"])).toBe(false);
    expect(看得到({ salesOwnerId: "u3", pool: {} }, ["u1"])).toBe(true);
    expect(看得到({ salesOwnerId: "u3" }, null)).toBe(true);
  });
});

describe("规则关着", () => {
  it("谁都照旧看全部", async () => {
    await 开规则(false);
    expect(await 作为(外人, 名单)).toHaveLength(7);
    expect(await 作为(外人, () => 读的我(raw))).toBeNull();
  });
});

describe("规则开着", () => {
  beforeAll(() => 开规则(true));

  it("普通销售只看自己的和公海", async () => {
    expect(await 作为(外人, 名单)).toEqual(["E外人的", "G公海"]);
  });

  it("老板、总管理员看全部", async () => {
    expect(await 作为(老板, 名单)).toHaveLength(7);
    expect(await 作为(总管, 名单)).toHaveLength(7);
  });

  it("经理看自己、实线下属、虚线下属整条链和公海", async () => {
    expect(await 作为(经理, 名单)).toEqual(["A经理的", "B小王的", "C小张的", "D小赵的", "G公海"]);
  });

  it("经理能改实线下属的客户", async () => {
    const id = await 客户id("B小王的");
    await 作为(经理, () => db.customer.update({ where: { id }, data: { major: "经理改的" } }));
    expect((await raw.customer.findUniqueOrThrow({ where: { id } })).major).toBe("经理改的");
  });

  it("虚线上级改不了、转不了虚线下属的客户，给人话", async () => {
    const id = await 客户id("C小张的");
    await expect(作为(经理, () => db.customer.update({ where: { id }, data: { major: "x" } }))).rejects.toThrow(/虚线下属/);
    await expect(作为(经理, () => db.customer.update({ where: { id }, data: { salesOwnerId: 经理 } }))).rejects.toThrow(/虚线下属/);
    expect((await raw.customer.findUniqueOrThrow({ where: { id } })).salesOwnerId).toBe(小张);
  });

  it("虚线下属的客户下面连跟进也不能加；实线下属的能加", async () => {
    const 虚 = await 客户id("D小赵的");
    const 实 = await 客户id("B小王的");
    const 跟进 = (customerId: string) => db.followUp.create({ data: { type: "PHONE", title: "t", content: "c", customerId, ownerId: 经理 } });
    await expect(作为(经理, () => 跟进(虚))).rejects.toThrow(/虚线下属/);
    await 作为(经理, () => 跟进(实));
    expect(await raw.followUp.count({ where: { customerId: 虚 } })).toBe(0);
    expect(await raw.followUp.count({ where: { customerId: 实 } })).toBe(1);
  });

  it("只读客户：虚线下属的 = 全，自己链上的、公海的 = false", async () => {
    expect(await 作为(经理, () => 只读客户(raw, { salesOwnerId: 小张 }))).toBe("全");
    expect(await 作为(经理, () => 只读客户(raw, { salesOwnerId: 小王 }))).toBe(false);
    expect(await 作为(经理, () => 只读客户(raw, { salesOwnerId: 小张, pool: {} }))).toBe(false);
  });

  it("停用的人、不认识的人只看公海", async () => {
    expect(await 作为("ghost", 名单)).toEqual(["G公海"]);
    await raw.user.update({ where: { id: 外人 }, data: { active: false } });
    忘掉企业版范围();
    expect(await 作为(外人, 名单)).toEqual(["G公海"]);
    await raw.user.update({ where: { id: 外人 }, data: { active: true } });
  });

  it("没有请求（后台任务）不限定", async () => {
    expect(await 名单()).toHaveLength(7);
  });

  it("关掉规则、忘掉缓存后马上放开", async () => {
    expect(await 作为(外人, 名单)).toHaveLength(2);
    await 开规则(false);
    expect(await 作为(外人, 名单)).toHaveLength(7);
    await 开规则(true);
  });

  it("改完组织、缓存冷着，马上开事务写库不卡（单连接）", async () => {
    忘掉企业版范围();
    const id = await 客户id("B小王的");
    const 写 = 作为(经理, () => db.$transaction(async (tx) => tx.customer.update({ where: { id }, data: { remark: "事务里改" } }), { timeout: 3000, maxWait: 3000 }));
    await expect(写).resolves.toMatchObject({ remark: "事务里改" });
    // 数组形式也一样
    忘掉企业版范围();
    await expect(作为(经理, () => db.$transaction([db.customer.update({ where: { id }, data: { remark: "批量改" } })]))).resolves.toHaveLength(1);
  });
});
