/**
 * lib/scope-sql 在企业版以外（2026-10-26，企业版开关关着时个人版 / 团队版行为不能变）：
 *   - 团队版业务员、互看关：读的我() = 本人，会走裸 SQL；客户数、最近跟进的前 n 位要和钩子给 Prisma 加的 可见客户 逐个一致
 *   - 团队版互看开、老板（ADMIN）、业务主管（MANAGER）、个人版（没进团队）、网页版没开企业版：不限定，返回 null / 全部客户数，调用方照旧走 Prisma
 * 不设 CRM_ENTERPRISE；团队身份照桌面端真的认法：CRM_DATA_DIR 里的 .cloud.json（accountId）+ .team.json（互看）+ 本机 User.role。
 * 用拷出来的一份库、显式单连接，不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-scope-sql-team-"));
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
import { 忘掉限定, 读的我 } from "@/lib/team-scope";
import { 看得到的客户数, 最近跟进的客户 } from "@/lib/scope-sql";

const 老板 = "acct_boss";
const 主管 = "acct_mgr";
const 小王 = "acct_wang";
const 小李 = "acct_li";
const 团队文件 = path.join(临时.dir, ".team.json");

function 当(账号: "boss" | "mgr" | "wang" | "li") {
  fs.writeFileSync(path.join(临时.dir, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: "dk_test", accountId: 账号, name: 账号, contact: `${账号}@x.com`, models: [], loggedAt: new Date().toISOString() }));
  忘掉限定();
}
function 进团队(互看: boolean) {
  fs.writeFileSync(团队文件, JSON.stringify({ teamId: "t1xxxxxxxxxx", teamName: "队", joinSecret: "s", key: "k".repeat(43), device: "dWANG01", pulled: 0, 互看 }));
  忘掉限定();
}
function 出团队() {
  fs.rmSync(团队文件, { force: true });
  忘掉限定();
}

beforeAll(async () => {
  delete process.env.CRM_ENTERPRISE;
  process.env.DESKTOP_LOCAL = "1";
  process.env.CRM_DATA_DIR = 临时.dir;
  for (const t of ["ProjectNodeLog", "Project", "AiConversation", "AiProject", "Setting", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "ContractOwner", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerPool", "CustomerClaim", "EntMember", "EntDept"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  for (const [id, name, role] of [[老板, "老板", "ADMIN"], [主管, "主管", "MANAGER"], [小王, "小王", "SALES"], [小李, "小李", "SALES"]]) {
    await raw.user.create({ data: { id, email: `${id}@x.com`, name, password: "x", role } });
  }
  // 每人 15 位：五分之一没跟进过（排最后），跟进日和建档日只取几个值，好让排序键大面积撞车
  const 负责人们 = [小王, 小李, 老板, 主管];
  const 日 = (d: number, h = 0) => new Date(Date.UTC(2026, 9, d, h));
  const 编号: string[] = [];
  for (let i = 0; i < 负责人们.length * 15; i++) {
    const o = 负责人们[i % 负责人们.length];
    const c = await raw.customer.create({
      data: {
        name: `客户${i}`,
        phone: `139${String(i).padStart(8, "0")}`,
        salesOwnerId: o,
        // 小李名下有几位渠道是小王的；也有渠道负责人是自己、和负责人重了的（不能数两遍）
        ...(o === 小李 && i % 3 === 1 ? { channelOwnerId: 小王 } : o === 小王 && i % 4 === 0 ? { channelOwnerId: 小王 } : {}),
        lastFollowAt: i % 5 === 0 ? null : 日(1 + (i % 7), i % 2),
        createdAt: 日(1, i % 3),
      },
    });
    编号.push(c.id);
  }
  // 公海：小王看不到的、小王自己的（不能数两遍）、没跟进过的
  await raw.customerPool.createMany({ data: [0, 1, 2, 5, 10, 22, 35, 50].map((i) => ({ customerId: 编号[i] })) });
});

beforeEach(() => 出团队());

afterAll(async () => {
  delete process.env.DESKTOP_LOCAL;
  delete process.env.CRM_DATA_DIR;
  忘掉限定();
  await raw.$disconnect();
  fs.rmSync(临时.dir, { recursive: true, force: true });
});

const 键 = (c: { lastFollowAt: Date | null; createdAt: Date }) => `${c.lastFollowAt?.toISOString() ?? "-"}|${c.createdAt.toISOString()}`;

/** 裸 SQL 和钩子加了范围的 Prisma 对拍：数一样；前 n 位排序键逐位一样、编号一样（最后一组完全同键的只比那组之前的） */
async function 对拍(谁: string, n: number) {
  const 新数 = await 看得到的客户数();
  const 新号 = await 最近跟进的客户(n);
  const 旧数 = await db.customer.count();
  const 旧 = await db.customer.findMany({ orderBy: [{ lastFollowAt: "desc" }, { createdAt: "desc" }], take: n, select: { id: true, lastFollowAt: true, createdAt: true } });
  expect({ 谁, n: 新数 }).toEqual({ 谁, n: 旧数 });
  expect(新号, `${谁} 应该走裸 SQL`).not.toBeNull();
  const 行 = await raw.customer.findMany({ where: { id: { in: 新号! } }, select: { id: true, lastFollowAt: true, createdAt: true } });
  const 按号 = new Map(行.map((c) => [c.id, c]));
  const 新 = 新号!.map((id) => 按号.get(id)!);
  expect({ 谁, n, 键: 新.map(键) }).toEqual({ 谁, n, 键: 旧.map(键) });
  const 尾 = 旧.length ? 键(旧[旧.length - 1]) : "";
  const 前 = (xs: { id: string; lastFollowAt: Date | null; createdAt: Date }[]) => xs.filter((c) => 键(c) !== 尾).map((c) => c.id).sort();
  expect({ 谁, n, 号: 前(新) }).toEqual({ 谁, n, 号: 前(旧) });
  return 新数;
}

/** 不限定：两个函数都不走裸 SQL，数的是全部客户 */
async function 不限定(谁: string) {
  expect(await 读的我(raw), 谁).toBeNull();
  expect(await 最近跟进的客户(50), 谁).toBeNull();
  expect(await 看得到的客户数(), 谁).toBe(await raw.customer.count());
}

describe("看得到的客户：企业版关着时（个人版 / 团队版）", () => {
  it("团队业务员、互看关：走裸 SQL，客户数和前 3 / 20 / 全部都和 Prisma 一致", async () => {
    进团队(false);
    for (const [账号, id] of [["wang", 小王], ["li", 小李]] as const) {
      当(账号);
      expect(await 读的我(raw)).toBe(id);
      for (const n of [3, 20, 1000]) await 对拍(id, n);
    }
    // 小王：自己负责的 + 渠道是他的（小李名下几位）+ 公海，不重数
    当("wang");
    const 应 = await raw.customer.count({ where: { OR: [{ salesOwnerId: 小王 }, { channelOwnerId: 小王 }, { pool: { isNot: null } }] } });
    expect(应).toBeLessThan(await raw.customer.count());
    expect(await 看得到的客户数()).toBe(应);
  });

  it("团队业务员、互看开：返回 null，走回 Prisma", async () => {
    进团队(true);
    当("wang");
    await 不限定("小王/互看");
  });

  it("老板、业务主管：返回 null", async () => {
    进团队(false);
    当("boss");
    await 不限定("老板");
    当("mgr");
    await 不限定("主管");
  });

  it("个人版（没进团队）：返回 null", async () => {
    当("wang");
    await 不限定("个人版");
  });

  it("网页版没开企业版（不是桌面端、没设 CRM_ENTERPRISE）：返回 null", async () => {
    delete process.env.DESKTOP_LOCAL;
    try {
      忘掉限定();
      await 不限定("网页版");
    } finally {
      process.env.DESKTOP_LOCAL = "1";
    }
  });
});
