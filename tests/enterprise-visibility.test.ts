/**
 * 企业版「按组织架构看客户」（lib/enterprise/visibility.ts + team-scope 加上限定）。
 * 钉的是：规则关着 = 照旧看全部；开了以后销售只看自己的和公海，直属上级看、改整条下属链，
 * 虚线上级只能看（改、转、在下面加跟进都拦）；老板、总管理员看全部；没认出人只看公海；后台任务不限定。
 * 虚线上级批量改负责人：客户改不动，客户下面的项目、待办也不能被带走（一周模拟 D2 查出来的）。
 * 虚线下属的客户被挡时说对原因：批量转 / 删 / 放公海 / 批量状态不报「已不存在」，编辑不用团队版的话（10-25 实测 F4 / F5）。
 * 客户页页签数（公海表相减）带范围时和按 pool 条件数的逐个身份对拍（2026-10-26 企业版 p95）。
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
const 登录 = vi.hoisted(() => ({ user: { id: "", name: "", email: "", role: "SALES", title: "", avatar: null } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => 登录.user }));
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  const { 加上限定 } = await import("@/lib/team-scope");
  const raw = new PrismaClient({ datasourceUrl: `file:${path.join(临时.dir, "A.db")}?connection_limit=1` });
  return { prisma: 加上限定(raw), defaultClient: raw };
});

import { prisma as db, defaultClient as raw } from "@/lib/prisma";
import { 以谁的身份, 忘掉企业版范围, 组织范围of } from "@/lib/enterprise/visibility";
import { 建组织 } from "@/lib/enterprise/org-core";
import { 只读客户, 读的我, 限定条件, 看得到, 只读话, 虚线只读的, 只读错误 } from "@/lib/team-scope";
import { 规则 } from "@/lib/enterprise/rules";
import { 虚线只读话 } from "@/lib/enterprise/visibility";
import { assignSalesOwner, deleteCustomers, 客户删除预检, bulkFollowStatus, patchCustomer, saveCustomer } from "@/app/(app)/customers/actions";
import { 放进公海 } from "@/app/(app)/customers/pool-actions";
import { 客户页签数 } from "@/lib/pool-db";

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
  for (const t of ["ProjectNodeLog", "Project", "AiConversation", "AiProject", "Setting", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "ContractOwner", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerPool", "CustomerClaim", "EntMember", "EntDept"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
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
  it("D-39 既是直属又是虚线上级：权限取并集，按直属算能改（小王进写，不只在读里）", () => {
    const o = 建组织(
      [经理, 小王, 小赵].map((id) => ({ id, role: "SALES", active: true })),
      [
        { userId: 小王, deptId: null, bizRole: "sales", line: null, managerId: 经理, dottedManagerId: 经理 },
        { userId: 小赵, deptId: null, bizRole: "sales", line: null, managerId: 小王, dottedManagerId: null },
      ],
      [],
    );
    expect(组织范围of(o, "SALES", 经理)).toEqual({ 写: expect.arrayContaining([经理, 小王, 小赵]) });
    expect(组织范围of(o, "SALES", 经理)!.读).toBeUndefined();
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

  it("客户页页签数：带范围也 = 按 pool 条件两头数的（逐个身份对拍；左栏角标 = 两数相加）", async () => {
    // 再放两位进公海：一位负责人是经理链上的（看得到的人名下，不能数两遍），一位是外人的
    const 加的 = [await 客户id("B小王的"), await 客户id("E外人的")];
    await raw.customerPool.createMany({ data: 加的.map((customerId) => ({ customerId })) });
    try {
      const 照旧数 = async () => ({
        公海: await db.customer.count({ where: { pool: { isNot: null } } }),
        非公海: await db.customer.count({ where: { pool: { is: null } } }),
      });
      for (const 谁 of [老板, 总管, 经理, 小王, 小张, 小赵, 外人, "ghost"]) {
        const [新, 旧, 角标] = await 作为(谁, async () => [await 客户页签数(), await 照旧数(), await db.customer.count()] as const);
        expect({ 谁, ...新 }).toEqual({ 谁, ...旧 });
        expect(新.公海 + 新.非公海).toBe(角标);
      }
      expect(await 作为(经理, 客户页签数)).toEqual({ 公海: 3, 非公海: 3 });
      expect(await 作为("ghost", 客户页签数)).toEqual({ 公海: 3, 非公海: 0 });
    } finally {
      await raw.customerPool.deleteMany({ where: { customerId: { in: 加的 } } });
    }
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

describe("虚线下属的客户被挡时说对原因（F4 / F5）", () => {
  beforeAll(() => 开规则(true));
  beforeEach(() => { 登录.user = { ...登录.user, id: 经理, name: "经理", role: "SALES" }; });
  const 不说已删 = (r: unknown) => expect(JSON.stringify(r)).not.toMatch(/不存在|删掉|删除了|不在了/);

  it("虚线只读的：经理那一批里挑出虚线下属链上的；实线下属、自己的不算", async () => {
    const ids = await Promise.all(["A经理的", "B小王的", "C小张的", "D小赵的"].map(客户id));
    expect(await 作为(经理, () => 虚线只读的(raw, ids))).toEqual([ids[2], ids[3]]);
    expect(await 作为(小王, () => 虚线只读的(raw, ids))).toEqual([]);
  });

  it("批量转、删、删前预检、批量状态、放公海：单选一位虚线客户 → 虚线那句，不说已删；客户原样", async () => {
    const id = await 客户id("C小张的");
    for (const r of [
      await 作为(经理, () => assignSalesOwner([id], 经理)),
      await 作为(经理, () => 客户删除预检([id])),
      await 作为(经理, () => deleteCustomers([id])),
      await 作为(经理, () => bulkFollowStatus([id], "跟进中")),
      await 作为(经理, () => 放进公海([id])),
    ]) {
      expect(r).toEqual({ ok: false, error: 虚线只读话 });
      不说已删(r);
    }
    const c = await raw.customer.findUniqueOrThrow({ where: { id }, include: { pool: true } });
    expect([c.salesOwnerId, c.followStatus === "跟进中", !!c.pool]).toEqual([小张, false, false]);
  });

  it("多选里混了两位虚线客户：说几位、叫人去掉再试", async () => {
    const ids = await Promise.all(["B小王的", "C小张的", "D小赵的"].map(客户id));
    const r = await 作为(经理, () => deleteCustomers(ids));
    expect(r).toEqual({ ok: false, error: "选中的有 2 位是虚线下属的客户：只能看，不能改、不能转、不能删。去掉这几位再试" });
    expect(await raw.customer.count({ where: { id: { in: ids } } })).toBe(3);
  });

  it("实线下属的照常走（预检不被虚线挡）", async () => {
    const id = await 客户id("B小王的");
    expect(await 作为(经理, () => 客户删除预检([id]))).toEqual({ ok: true });
  });

  it("编辑（整表保存 / 单格改）被挡用虚线那句，不用团队版「同事的客户」", async () => {
    const c = await raw.customer.findUniqueOrThrow({ where: { id: await 客户id("C小张的") } });
    const 值 = { name: c.name, phone: c.phone, school: c.school, grade: c.grade, major: c.major, followStatus: c.followStatus, decisionStatus: c.decisionStatus, expectedSignAt: c.expectedSignAt, remark: c.remark, salesOwnerId: c.salesOwnerId, channelId: c.channelId, referrerCustomerId: c.referrerCustomerId, channelOwnerId: c.channelOwnerId };
    const 存 = await 作为(经理, () => saveCustomer({ id: c.id, updatedAt: c.updatedAt.toISOString(), base: 值, ...值, major: "改" } as Parameters<typeof saveCustomer>[0]));
    expect(存).toEqual({ ok: false, error: 虚线只读话 });
    expect(await 作为(经理, () => patchCustomer(c.id, "major", "改"))).toEqual({ ok: false, error: 虚线只读话 });
  });

  it("规则关着：没有虚线只读的，只读话回团队版那句（团队版互看照旧）", async () => {
    await 开规则(false);
    try {
      const id = await 客户id("C小张的");
      expect(await 作为(经理, () => 虚线只读的(raw, [id]))).toEqual([]);
      expect(await 作为(经理, () => 只读话(raw))).toBe(new 只读错误().message);
    } finally {
      await 开规则(true);
    }
  });
});

describe("虚线上级批量改负责人", () => {
  beforeAll(() => 开规则(true));

  it("虚线下属的客户改不动，下面的项目、待办留在原负责人名下；实线下属的照常带走", async () => {
    const 建 = async (name: string, ownerId: string) => {
      const c = await raw.customer.create({ data: { name, phone: `1390000${name.charCodeAt(0)}`, salesOwnerId: ownerId } });
      const p = await raw.project.create({ data: { name: `${name}项目`, customerId: c.id, ownerId, creatorId: ownerId } });
      const t = await raw.task.create({ data: { title: "回访", customerId: c.id, ownerId } });
      return { c: c.id, p: p.id, t: t.id };
    };
    const 虚 = await 建("H小张的", 小张);
    const 实 = await 建("I小王的", 小王);
    登录.user = { ...登录.user, id: 经理, name: "经理", role: "SALES" };
    // 混着选：整批先挡下、说清是哪几位（F4），一条不动
    const 混 = await 作为(经理, () => assignSalesOwner([虚.c, 实.c], 外人));
    expect(混).toEqual({ ok: false, error: expect.stringMatching(/有 1 位是虚线下属的客户/) });
    const r = await 作为(经理, () => assignSalesOwner([实.c], 外人));
    expect(r).toMatchObject({ ok: true, updated: 1 });
    const 归谁 = async (x: { c: string; p: string; t: string }) => [
      (await raw.customer.findUniqueOrThrow({ where: { id: x.c } })).salesOwnerId,
      (await raw.project.findUniqueOrThrow({ where: { id: x.p } })).ownerId,
      (await raw.task.findUniqueOrThrow({ where: { id: x.t } })).ownerId,
    ];
    expect(await 归谁(虚)).toEqual([小张, 小张, 小张]);
    expect(await 归谁(实)).toEqual([外人, 外人, 外人]);
    expect(r.ok && r.原值).toEqual([{ id: 实.c, 值: 小王 }]);
  });
});

describe("市场管理看线索（F9 10-25）", () => {
  const 市场 = "e_mkt";
  const 开分配 = async (on: boolean) => {
    await raw.setting.upsert({ where: { key: 规则.线索分配.key }, update: { value: JSON.stringify(on) }, create: { key: 规则.线索分配.key, value: JSON.stringify(on) } });
    忘掉企业版范围();
  };
  const 线索们 = () => db.lead.findMany({ orderBy: { name: "asc" } }).then((x) => x.map((l) => l.name));
  beforeAll(async () => {
    await 开规则(true);
    await raw.user.create({ data: { id: 市场, email: `${市场}@x.com`, name: "市场", password: "x", role: "SALES" } });
    await raw.entMember.create({ data: { userId: 市场, bizRole: "marketing_mgr" } });
    await raw.lead.createMany({ data: [{ id: "l_mkt", name: "L市场的", ownerId: 市场 }, { id: "l_wai", name: "L外人的", ownerId: 外人 }, { id: "l_wang", name: "L小王的", ownerId: 小王 }] });
  });
  afterAll(() => 开分配(false));

  it("线索分配关着：市场管理只看自己名下的线索", async () => {
    await 开分配(false);
    expect(await 作为(市场, 线索们)).toEqual(["L市场的"]);
    await expect(作为(市场, () => db.lead.update({ where: { id: "l_wai" }, data: { remark: "x" } }))).rejects.toThrow();
  });

  it("线索分配开着：市场管理看、改全部线索（分出去以后还看得到、分得了）；客户照旧按组织架构", async () => {
    await 开分配(true);
    expect(await 作为(市场, 线索们)).toEqual(["L外人的", "L小王的", "L市场的"]);
    await expect(作为(市场, () => db.lead.update({ where: { id: "l_wai" }, data: { ownerId: 小王 } }))).resolves.toMatchObject({ ownerId: 小王 });
    expect(await 作为(市场, 名单)).toEqual(["G公海"]);
  });

  it("线索分配开着：不是市场管理的照旧（经理只看自己和实线下属的）", async () => {
    await 开分配(true);
    // 上一条把 L外人的 分给了小王：经理看得到小王名下的两条，看不到市场名下的
    expect(await 作为(经理, 线索们)).toEqual(["L外人的", "L小王的"]);
    expect(await 作为(外人, 线索们)).toEqual([]);
    await expect(作为(经理, () => db.lead.update({ where: { id: "l_mkt" }, data: { remark: "x" } }))).rejects.toThrow();
  });
});
