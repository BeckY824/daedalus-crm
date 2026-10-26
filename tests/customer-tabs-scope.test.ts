/**
 * 客户页页签数（lib/pool-db.ts 客户页签数：数一次客户、数一次公海表再相减）在企业版「按组织看客户」开着时
 * 和按 pool 条件两头数的逐个身份对拍（2026-10-26 企业版 p95）。公海客户人人看得到，所以带范围也成立。
 * 用拷出来的一份库、显式单连接，不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-tabs-scope-"));
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
import { 客户页签数 } from "@/lib/pool-db";

const 老板 = "e_boss";
const 总管 = "e_dir";
const 经理 = "e_mgr";
const 小王 = "e_wang"; // 经理的实线下属
const 小张 = "e_zhang"; // 经理的虚线下属
const 小赵 = "e_zhao"; // 小张的实线下属（经理虚线链上）
const 外人 = "e_other";

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
  const id = {} as Record<string, string>;
  for (const [n, o] of [["A经理的", 经理], ["B小王的", 小王], ["C小张的", 小张], ["D小赵的", 小赵], ["E外人的", 外人], ["F老板的", 老板], ["G公海", 老板], ["H经理渠道的", 外人]] as const)
    id[n] = (await raw.customer.create({ data: { name: n, phone: `1380000${n.charCodeAt(0)}`, salesOwnerId: o, ...(n === "H经理渠道的" ? { channelOwnerId: 经理 } : {}) } })).id;
  // 公海三位：一位没人看得到的、一位负责人在经理链上（看得到的人名下，不能数两遍）、一位是外人的
  await raw.customerPool.createMany({ data: ["G公海", "B小王的", "E外人的"].map((n) => ({ customerId: id[n] })) });
  await raw.setting.create({ data: { key: 规则.按组织看客户.key, value: JSON.stringify(true) } });
});

beforeEach(() => 忘掉企业版范围());

afterAll(async () => {
  delete process.env.CRM_ENTERPRISE;
  忘掉企业版范围();
  await raw.$disconnect();
  fs.rmSync(临时.dir, { recursive: true, force: true });
});

describe("客户页签数带范围", () => {
  const 照旧数 = async () => ({
    公海: await db.customer.count({ where: { pool: { isNot: null } } }),
    非公海: await db.customer.count({ where: { pool: { is: null } } }),
  });

  it("逐个身份 = 按 pool 条件两头数的；左栏角标 = 两数相加", async () => {
    for (const 谁 of [老板, 总管, 经理, 小王, 小张, 小赵, 外人, "ghost"]) {
      const [新, 旧, 角标] = await 以谁的身份(谁, async () => [await 客户页签数(), await 照旧数(), await db.customer.count()] as const);
      expect({ 谁, ...新 }).toEqual({ 谁, ...旧 });
      expect(新.公海 + 新.非公海).toBe(角标);
    }
  });

  it("看得到的数对：老板全部、经理链（含渠道是他的外人客户）、外人、没认出人只看公海", async () => {
    expect(await 以谁的身份(老板, 客户页签数)).toEqual({ 公海: 3, 非公海: 5 });
    expect(await 以谁的身份(经理, 客户页签数)).toEqual({ 公海: 3, 非公海: 4 });
    expect(await 以谁的身份(外人, 客户页签数)).toEqual({ 公海: 3, 非公海: 1 });
    expect(await 以谁的身份("ghost", 客户页签数)).toEqual({ 公海: 3, 非公海: 0 });
  });
});
