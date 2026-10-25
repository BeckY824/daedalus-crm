/**
 * 企业版的只读通道（lib/read-pool.ts + lib/prisma.ts 的分流）。
 * 钉的是：
 * - 默认关；只有企业版开；CRM_READ_POOL=0 一键关回单连接；桌面端、多租户不开
 * - 只读通道上拿不到 $transaction、$executeRaw、任何写方法，裸 SQL 只放单句 SELECT / WITH
 * - 开着时查询真的走了另外的连接（主连接被交互式事务占着时照样查得出），写入和事务照旧排在主连接上
 * - 主连接刚写完，只读通道马上读得到
 * - 开 / 关两种，各种查法在业务员限定、按组织看客户下结果一模一样（对拍）
 * 用拷出来的一份库，真走 lib/prisma（不 mock），不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { vi } from "vitest";
import fs from "node:fs";

const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-read-pool-"));
  const 原连接串 = process.env.DATABASE_URL;
  fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(dir, "A.db"));
  if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(dir, "A.db-wal"));
  // lib/prisma 在加载时读连接串：先换成这份
  process.env.DATABASE_URL = `file:${path.join(dir, "A.db")}`;
  return { dir, 原连接串 };
});

import { prisma, defaultClient as raw } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { 读通道, 读通道开着, 关读通道, 守门, 只读SQL, 取SQL, 读连接串, 只读通道错误 } from "@/lib/read-pool";
import { 以谁的身份, 忘掉企业版范围 } from "@/lib/enterprise/visibility";
import { 规则 } from "@/lib/enterprise/rules";

const 原环境 = { ...process.env };
const 设 = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
const 开 = () => { 设("CRM_ENTERPRISE", "1"); 设("CRM_READ_POOL", undefined); };
const 关 = () => 设("CRM_READ_POOL", "0");

const 老板 = "rp_boss";
const 经理 = "rp_mgr";
const 小王 = "rp_wang";
const 小张 = "rp_zhang";

beforeAll(async () => {
  设("DESKTOP_LOCAL", undefined);
  设("MULTI_TENANT", undefined);
  for (const t of ["AiConversation", "AiProject", "Setting", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "ContractOwner", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerPool", "CustomerClaim", "EntMember", "EntDept"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  const 人 = (id: string, name: string, role = "SALES") => raw.user.create({ data: { id, email: `${id}@x.com`, name, password: "x", role } });
  await 人(老板, "老板", "ADMIN");
  for (const [id, n] of [[经理, "经理"], [小王, "小王"], [小张, "小张"]]) await 人(id, n);
  await raw.entMember.createMany({ data: [{ userId: 经理, bizRole: "sales_mgr" }, { userId: 小王, managerId: 经理 }, { userId: 小张 }] });
  let i = 0;
  for (const o of [经理, 小王, 小张, 老板]) {
    for (let k = 0; k < 6; k++) {
      i++;
      const c = await raw.customer.create({
        data: { name: `客户${String(i).padStart(2, "0")}`, phone: `139${String(i).padStart(8, "0")}`, salesOwnerId: o, followStatus: k % 2 ? "跟进中" : "待跟进", school: k % 3 ? "北大" : null },
      });
      await raw.opportunity.create({ data: { name: `商机${i}`, customerId: c.id, ownerId: o, amount: 1000 * k, stage: k % 2 ? "需求确认" : "初步沟通", status: k === 5 ? "WON" : "OPEN" } });
      await raw.followUp.create({ data: { customerId: c.id, ownerId: o, type: "PHONE", title: `电话${i}`, content: "记录", occurredAt: new Date(Date.UTC(2026, 9, 1 + k)) } });
    }
  }
  const 公海 = await raw.customer.create({ data: { name: "客户公海", phone: "13900009999", salesOwnerId: 老板 } });
  await raw.customerPool.create({ data: { customerId: 公海.id } });
});

afterEach(async () => {
  for (const k of ["CRM_ENTERPRISE", "CRM_READ_POOL", "DESKTOP_LOCAL", "MULTI_TENANT"]) 设(k, 原环境[k]);
  忘掉企业版范围();
});

afterAll(async () => {
  await 关读通道();
  await raw.$disconnect();
  process.env.DATABASE_URL = 临时.原连接串;
  fs.rmSync(临时.dir, { recursive: true, force: true });
});

describe("开关", () => {
  it("默认关；企业版开；CRM_READ_POOL=0 关；桌面端、多租户不开；不是 SQLite 文件不开", () => {
    设("CRM_ENTERPRISE", undefined);
    expect(读通道开着()).toBe(false);
    expect(读通道()).toBeNull();
    开();
    expect(读通道开着()).toBe(true);
    关();
    expect(读通道开着()).toBe(false);
    开();
    设("DESKTOP_LOCAL", "1");
    expect(读通道开着()).toBe(false);
    设("DESKTOP_LOCAL", undefined);
    设("MULTI_TENANT", "1");
    expect(读通道开着()).toBe(false);
    设("MULTI_TENANT", undefined);
    const url = process.env.DATABASE_URL;
    设("DATABASE_URL", "postgresql://x");
    expect(读通道开着()).toBe(false);
    设("DATABASE_URL", url);
    expect(读通道开着()).toBe(true);
  });

  it("连接串换成 4 个连接，原来写了 connection_limit 的也换", () => {
    expect(读连接串("file:/a.db")).toBe("file:/a.db?connection_limit=4");
    expect(读连接串("file:/a.db?connection_limit=1")).toBe("file:/a.db?connection_limit=4");
    expect(读连接串("file:/a.db?connection_limit=1&socket_timeout=5")).toBe("file:/a.db?socket_timeout=5&connection_limit=4");
    expect(读连接串("file:/a.db?socket_timeout=5&connection_limit=1")).toBe("file:/a.db?socket_timeout=5&connection_limit=4");
  });
});

describe("只读通道拿不到写", () => {
  const 门 = 守门(raw);
  const 拦 = (f: () => unknown) => expect(f).toThrow(只读通道错误);

  it("事务、裸写、连接管理一律拦", () => {
    const 任意 = 门 as unknown as Record<string, unknown>;
    for (const k of ["$transaction", "$executeRaw", "$executeRawUnsafe", "$extends", "$connect", "$disconnect", "$on", "_engine"]) 拦(() => 任意[k]);
  });

  it("模型上只有查和数", () => {
    const c = 门.customer as unknown as Record<string, unknown>;
    for (const m of ["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"]) 拦(() => c[m]);
    for (const m of ["findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "count", "aggregate", "groupBy"]) expect(typeof c[m]).toBe("function");
  });

  it("裸 SQL 只放单句 SELECT / WITH", async () => {
    拦(() => 门.$queryRawUnsafe("DELETE FROM Customer"));
    拦(() => 门.$queryRawUnsafe("PRAGMA journal_mode"));
    拦(() => 门.$queryRawUnsafe("SELECT 1; DELETE FROM Customer"));
    拦(() => 门.$queryRawUnsafe("WITH x AS (SELECT 1) INSERT INTO Setting(key,value) SELECT 'a','b'"));
    拦(() => 门.$queryRawUnsafe("SELECT * FROM Customer RETURNING id"));
    拦(() => 门.$queryRaw`UPDATE Customer SET name = ${"x"}`);
    拦(() => (门.$queryRawUnsafe as (x: unknown) => unknown)({ sql: "SELECT 1" }));
    expect(await 门.$queryRawUnsafe<{ n: bigint }[]>("SELECT count(*) AS n FROM Customer")).toHaveLength(1);
    expect(await 门.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM Customer WHERE name LIKE ${"客户%"}`).toHaveLength(1);
    expect(await 门.$queryRaw<{ n: bigint }[]>(Prisma.sql`WITH a AS (SELECT id FROM Customer) SELECT count(*) AS n FROM a`)).toHaveLength(1);
  });

  it("只读SQL / 取SQL 的边界", () => {
    expect(只读SQL("  select 1")).toBe(true);
    expect(只读SQL("WITH a AS (SELECT 1) SELECT * FROM a")).toBe(true);
    expect(只读SQL("SELECT 1 -- x")).toBe(false);
    expect(只读SQL("SELECT /* x */ 1")).toBe(false);
    expect(只读SQL("SELECT * FROM Customer WHERE name = 'update'")).toBe(false); // 认不准的宁可回主连接
    expect(只读SQL("EXPLAIN SELECT 1")).toBe(false);
    expect(取SQL("$queryRawUnsafe", ["SELECT 1"])).toBe("SELECT 1");
    expect(取SQL("$queryRaw", [Prisma.sql`SELECT ${1}`])).toBe("SELECT ?");
    expect(取SQL("$executeRaw", [Prisma.sql`SELECT 1`])).toBeNull();
    expect(取SQL("$queryRaw", [123])).toBeNull();
  });

  it("只读通道的连接也有 busy_timeout ≥ 5 秒、在 WAL 下", async () => {
    开();
    expect(读通道()).not.toBeNull();
    const g = globalThis as unknown as { __读通道: { 原: typeof raw } };
    for (let k = 0; k < 4; k++) {
      const [t] = await g.__读通道.原.$queryRawUnsafe<{ timeout: number }[]>("PRAGMA busy_timeout");
      expect(Number(t.timeout)).toBeGreaterThanOrEqual(5000);
    }
    const [j] = await g.__读通道.原.$queryRawUnsafe<{ journal_mode: string }[]>("PRAGMA journal_mode");
    expect(String(j.journal_mode).toLowerCase()).toBe("wal");
  });
});

/** 主连接上开一个交互式事务、写一条、停在那：等 放行() 才提交 */
function 占着主连接() {
  let 放行!: () => void;
  const 等 = new Promise<void>((r) => (放行 = r));
  let 写好!: () => void;
  const 写了 = new Promise<void>((r) => (写好 = r));
  const 完 = prisma.$transaction(async (tx) => {
    await tx.setting.create({ data: { key: "rp_未提交", value: "1" } });
    写好();
    await 等;
  }, { timeout: 15_000 });
  return { 写了, 放行, 完 };
}

const 赛跑 = async <T,>(p: Promise<T>, ms = 500): Promise<T | "超时"> => Promise.race([p, new Promise<"超时">((r) => setTimeout(() => r("超时"), ms))]);

describe("分流", () => {
  afterEach(async () => { await raw.setting.deleteMany({ where: { key: { startsWith: "rp_" } } }); });

  it("开着：主连接被事务占着时，查询走只读通道马上回来，看不到没提交的；写照旧排在主连接后面", async () => {
    开();
    const 占 = 占着主连接();
    await 占.写了;
    expect(await 赛跑(prisma.setting.count({ where: { key: "rp_未提交" } }))).toBe(0);
    expect(await 赛跑(prisma.customer.findMany({ select: { id: true } }))).not.toBe("超时");
    expect(await 赛跑(prisma.$queryRaw<unknown[]>`SELECT count(*) AS n FROM Setting`)).not.toBe("超时");
    // 写不进只读通道：要等事务提交才轮到
    const 写 = prisma.setting.create({ data: { key: "rp_外面写", value: "1" } });
    expect(await 赛跑(写)).toBe("超时");
    // 裸 SQL 写、非只读 SQL 也在主连接上
    const 裸 = prisma.$queryRawUnsafe("PRAGMA busy_timeout");
    expect(await 赛跑(裸, 200)).toBe("超时");
    占.放行();
    await 占.完;
    await 写;
    await 裸;
    expect(await prisma.setting.count({ where: { key: { in: ["rp_未提交", "rp_外面写"] } } })).toBe(2);
  });

  it("关着（CRM_READ_POOL=0）：和原来一样，所有查询排在那一个连接上", async () => {
    开();
    关();
    const 占 = 占着主连接();
    await 占.写了;
    const 查 = prisma.setting.count({ where: { key: "rp_未提交" } });
    expect(await 赛跑(查)).toBe("超时");
    占.放行();
    await 占.完;
    expect(await 查).toBe(1);
  });

  it("不是企业版：一个连接都不多开", async () => {
    设("CRM_ENTERPRISE", undefined);
    await 关读通道();
    await prisma.customer.count();
    expect((globalThis as { __读通道?: unknown }).__读通道).toBeUndefined();
  });

  it("主连接刚写完，只读通道马上读得到", async () => {
    开();
    for (let k = 0; k < 20; k++) {
      await prisma.setting.create({ data: { key: `rp_读写${k}`, value: String(k) } });
      expect((await prisma.setting.findUnique({ where: { key: `rp_读写${k}` } }))?.value).toBe(String(k));
      await prisma.setting.update({ where: { key: `rp_读写${k}` }, data: { value: "改" } });
      expect((await prisma.setting.findFirst({ where: { key: `rp_读写${k}` } }))?.value).toBe("改");
    }
  });

  it("交互式事务里 tx 的查询还在事务里：看得到自己刚写的", async () => {
    开();
    const 看到 = await prisma.$transaction(async (tx) => {
      await tx.setting.create({ data: { key: "rp_事务内", value: "1" } });
      return tx.setting.count({ where: { key: "rp_事务内" } });
    });
    expect(看到).toBe(1);
  });

  it("数组式事务里混进只读通道的查询：直接报错，不悄悄放到事务外面跑", async () => {
    开();
    expect(() => prisma.$transaction([prisma.setting.count(), prisma.setting.create({ data: { key: "rp_数组", value: "1" } })])).toThrow(/数组式 \$transaction/);
    expect(await raw.setting.count({ where: { key: "rp_数组" } })).toBe(0);
    // 全是写（主连接上建的）照旧能用
    await prisma.$transaction([prisma.setting.create({ data: { key: "rp_数组2", value: "1" } }), prisma.setting.deleteMany({ where: { key: "rp_数组2" } })]);
    expect(await raw.setting.count({ where: { key: "rp_数组2" } })).toBe(0);
  });

  it("CRM_READ_POOL=0 改了马上生效（每次调用现判）", async () => {
    开();
    const 占 = 占着主连接();
    await 占.写了;
    expect(await 赛跑(prisma.setting.count())).not.toBe("超时");
    关();
    const 查 = prisma.setting.count();
    expect(await 赛跑(查)).toBe("超时");
    占.放行();
    await 占.完;
    await 查;
  });
});

describe("对拍：开 / 关结果一模一样", () => {
  const 开规则 = async (on: boolean) => {
    await raw.setting.upsert({ where: { key: 规则.按组织看客户.key }, update: { value: JSON.stringify(on) }, create: { key: 规则.按组织看客户.key, value: JSON.stringify(on) } });
    忘掉企业版范围();
  };

  const 一批 = () =>
    Promise.all([
      prisma.customer.findMany({ orderBy: { name: "asc" }, select: { name: true, salesOwnerId: true } }),
      prisma.customer.findMany({ where: { followStatus: "跟进中" }, orderBy: { phone: "desc" }, take: 5, skip: 1 }),
      prisma.customer.count(),
      prisma.customer.count({ where: { school: { not: null } } }),
      prisma.customer.groupBy({ by: ["followStatus"], _count: true, orderBy: { followStatus: "asc" } }),
      prisma.customer.findFirst({ orderBy: { name: "desc" }, select: { name: true } }),
      prisma.opportunity.findMany({ orderBy: { name: "asc" }, select: { name: true, amount: true, customer: { select: { name: true } } } }),
      prisma.opportunity.aggregate({ _sum: { amount: true }, _count: true, where: { status: "OPEN" } }),
      prisma.opportunity.groupBy({ by: ["stage", "status"], _sum: { amount: true }, orderBy: [{ stage: "asc" }, { status: "asc" }] }),
      prisma.followUp.findMany({ orderBy: { title: "asc" }, select: { title: true } }),
      prisma.followUp.count(),
      prisma.customer.findMany({ orderBy: { name: "asc" }, select: { name: true, _count: { select: { followUps: true, opportunities: true } } } }),
      prisma.user.findMany({ orderBy: { id: "asc" }, select: { id: true, role: true } }),
      prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM Customer`,
      prisma.$queryRawUnsafe<{ s: string }[]>("SELECT followStatus AS s FROM Customer ORDER BY name"),
      (async () => {
        const c = await prisma.customer.findFirstOrThrow({ orderBy: { name: "asc" } });
        return prisma.customer.findUnique({ where: { id: c.id }, select: { name: true } });
      })(),
    ]);

  for (const 规则开 of [false, true]) {
    it(`按组织看客户 ${规则开 ? "开" : "关"}：老板、经理、小王、小张、没认出人、后台`, async () => {
      await 开规则(规则开);
      const 跑 = async () => {
        const 出 = [];
        for (const id of [老板, 经理, 小王, 小张, "rp_不认识"]) { 忘掉企业版范围(); 出.push(await 以谁的身份(id, 一批)); }
        忘掉企业版范围();
        出.push(await 一批());
        return JSON.parse(JSON.stringify(出, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));
      };
      开();
      关();
      const 原来 = await 跑();
      开();
      const 现在 = await 跑();
      expect(现在).toEqual(原来);
      // 规则开着时各人看到的确实不一样（不是全都空的、对拍是真对上的）
      const 各人客户数 = 原来.map((x: unknown[]) => x[2]);
      if (规则开) expect(new Set(各人客户数).size).toBeGreaterThan(2);
      else expect(new Set(各人客户数).size).toBe(1);
    });
  }
});
