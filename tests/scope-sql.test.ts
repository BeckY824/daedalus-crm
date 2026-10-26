/**
 * lib/scope-sql（看得到的客户：负责人 OR 渠道负责人 OR 在公海表里）和钩子给 Prisma 加的 可见客户 逐个身份对拍
 * （2026-10-26 企业版 p95）：客户数要一样；最近跟进的前 n 位，排序键逐位一样、编号一样（最后一位那组完全同键的
 * 谁先谁后两边都没定，只比那组之前的）。用拷出来的一份库、显式单连接，不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-scope-sql-"));
  fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(dir, "A.db"));
  if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(dir, "A.db-wal"));
  return { dir };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  const { 加上限定 } = await import("@/lib/team-scope");
  const raw = new PrismaClient({ datasourceUrl: `file:${path.join(临时.dir, "A.db")}?connection_limit=1` });
  return { prisma: 加上限定(raw), defaultClient: raw };
});

import { prisma as db, defaultClient as raw } from "@/lib/prisma";
import { 以谁的身份, 忘掉企业版范围 } from "@/lib/enterprise/visibility";
import { 规则 } from "@/lib/enterprise/rules";
import { 看得到的客户数, 最近跟进的客户 } from "@/lib/scope-sql";

const 老板 = "e_boss";
const 总管 = "e_dir";
const 经理 = "e_mgr";
const 小王 = "e_wang"; // 经理的实线下属
const 小张 = "e_zhang"; // 经理的虚线下属
const 小赵 = "e_zhao"; // 小张的实线下属（经理虚线链上）
const 外人 = "e_other";
const 谁们 = [老板, 总管, 经理, 小王, 小张, 小赵, 外人, "ghost"];

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
  // 每人 14 位：五分之一没跟进过（排最后），跟进日和建档日只取几个值，好让排序键大面积撞车
  const 负责人们 = [经理, 小王, 小张, 小赵, 外人, 老板];
  const 日 = (d: number, h = 0) => new Date(Date.UTC(2026, 9, d, h));
  const 编号: string[] = [];
  for (let i = 0; i < 负责人们.length * 14; i++) {
    const o = 负责人们[i % 负责人们.length];
    const c = await raw.customer.create({
      data: {
        name: `客户${i}`,
        phone: `139${String(i).padStart(8, "0")}`,
        salesOwnerId: o,
        // 外人名下有几位渠道是经理的；也有渠道负责人是自己、和负责人重了的（不能数两遍）
        ...(o === 外人 && i % 4 === 0 ? { channelOwnerId: 经理 } : o === 小王 && i % 3 === 0 ? { channelOwnerId: 小王 } : {}),
        lastFollowAt: i % 5 === 0 ? null : 日(1 + (i % 7), i % 2),
        createdAt: 日(1, i % 3),
      },
    });
    编号.push(c.id);
  }
  // 公海：负责人看不到的、负责人看得到的（不能数两遍）、没跟进过的
  await raw.customerPool.createMany({ data: [0, 1, 4, 9, 11, 22, 29, 40].map((i) => ({ customerId: 编号[i] })) });
});

beforeEach(() => 忘掉企业版范围());

afterAll(async () => {
  delete process.env.CRM_ENTERPRISE;
  忘掉企业版范围();
  await raw.$disconnect();
  fs.rmSync(临时.dir, { recursive: true, force: true });
});

const 键 = (c: { lastFollowAt: Date | null; createdAt: Date }) => `${c.lastFollowAt?.toISOString() ?? "-"}|${c.createdAt.toISOString()}`;

/** 照旧用 Prisma（钩子加 可见客户）数和排 */
async function 照旧(n: number) {
  const total = await db.customer.count();
  const top = await db.customer.findMany({ orderBy: [{ lastFollowAt: "desc" }, { createdAt: "desc" }], take: n, select: { id: true, lastFollowAt: true, createdAt: true } });
  return { total, top };
}

async function 对拍(谁: string, n: number) {
  const [新数, 新号, 旧] = await 以谁的身份(谁, async () => [await 看得到的客户数(), await 最近跟进的客户(n), await 照旧(n)] as const);
  expect({ 谁, n: 新数 }).toEqual({ 谁, n: 旧.total });
  if (新号 === null) return "不限定" as const;
  const 行 = await raw.customer.findMany({ where: { id: { in: 新号 } }, select: { id: true, lastFollowAt: true, createdAt: true } });
  const 按号 = new Map(行.map((c) => [c.id, c]));
  const 新 = 新号.map((id) => 按号.get(id)!);
  expect({ 谁, n, 键: 新.map(键) }).toEqual({ 谁, n, 键: 旧.top.map(键) });
  const 尾 = 旧.top.length ? 键(旧.top[旧.top.length - 1]) : "";
  const 前 = (xs: { id: string; lastFollowAt: Date | null; createdAt: Date }[]) => xs.filter((c) => 键(c) !== 尾).map((c) => c.id).sort();
  expect({ 谁, n, 号: 前(新) }).toEqual({ 谁, n, 号: 前(旧.top) });
  return 新号.length;
}

describe("看得到的客户：裸 SQL 和 Prisma 范围对拍", () => {
  it("按组织看客户开着：逐个身份、前 3 / 50 / 全部", async () => {
    await raw.setting.create({ data: { key: 规则.按组织看客户.key, value: JSON.stringify(true) } });
    const 量 = {} as Record<string, unknown>;
    for (const 谁 of 谁们) for (const n of [3, 50, 1000]) 量[`${谁}/${n}`] = await 对拍(谁, n);
    // 老板、总管不限定，走 Prisma；其余人都真走了裸 SQL
    expect(量[`${老板}/50`]).toBe("不限定");
    expect(量[`${总管}/50`]).toBe("不限定");
    for (const 谁 of [经理, 小王, 小张, 小赵, 外人, "ghost"]) expect(typeof 量[`${谁}/1000`]).toBe("number");
    await raw.setting.deleteMany({ where: { key: 规则.按组织看客户.key } });
  });

  it("看得到的数对：经理链（含渠道是他的外人客户）、外人、没认出人只看公海", async () => {
    await raw.setting.create({ data: { key: 规则.按组织看客户.key, value: JSON.stringify(true) } });
    const 公海 = await raw.customerPool.count();
    expect(await 以谁的身份("ghost", 看得到的客户数)).toBe(公海);
    const 经理看 = await raw.customer.count({ where: { OR: [{ salesOwnerId: { in: [经理, 小王, 小张, 小赵] } }, { channelOwnerId: 经理 }, { pool: { isNot: null } }] } });
    expect(await 以谁的身份(经理, 看得到的客户数)).toBe(经理看);
    expect(await 以谁的身份(老板, 看得到的客户数)).toBe(await raw.customer.count());
    await raw.setting.deleteMany({ where: { key: 规则.按组织看客户.key } });
  });

  it("按组织看客户关着：和 Prisma 照样一致", async () => {
    for (const 谁 of 谁们) await 对拍(谁, 50);
  });
});
