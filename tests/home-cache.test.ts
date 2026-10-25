/**
 * 首页重查询的短时缓存（lib/home-cache.ts）。钉的是：
 * - 库指纹（WAL 索引头）：任何提交都会变——模型写、裸 SQL 写、交互式事务提交、另一个连接写；只读不变
 * - 缓存着：同一份只数一次、同时来的共用一次；库一变下一次立刻重数；数失败不留；非企业版 / CRM_HOME_CACHE=0 每次现数
 * - 对拍：客户数、沉睡前几名开着缓存和关着结果一模一样；刚写进去的客户 / 跟进马上反映出来
 * 用拷出来的一份库（绝对路径，企业版开只读通道），不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { vi } from "vitest";
import fs from "node:fs";

const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-home-cache-"));
  const 原连接串 = process.env.DATABASE_URL;
  fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(dir, "H.db"));
  if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(dir, "H.db-wal"));
  process.env.DATABASE_URL = `file:${path.join(dir, "H.db")}`;
  return { dir, 原连接串 };
});

import { prisma, defaultClient as raw } from "@/lib/prisma";
import { PrismaClient } from "@/generated/prisma";
import { 关读通道 } from "@/lib/read-pool";
import { 库指纹, shm路径, 缓存着, 首页缓存开着, 清首页缓存 } from "@/lib/home-cache";
import { 客户数 } from "@/lib/dashboard-sql";
import { _内部 as 盯盘 } from "@/lib/sentinel-data";
import { dayjs } from "@/lib/utils";

const 原环境 = { ...process.env };
const 设 = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
const 开 = () => { 设("CRM_ENTERPRISE", "1"); 设("CRM_READ_POOL", undefined); 设("CRM_HOME_CACHE", undefined); };
const 关 = () => 设("CRM_HOME_CACHE", "0");
const 等 = (ms: number) => new Promise((r) => setTimeout(r, ms));
const 天 = 86_400_000;

let 老板 = "";

beforeAll(async () => {
  设("DESKTOP_LOCAL", undefined);
  设("MULTI_TENANT", undefined);
  for (const t of ["AiConversation", "AiProject", "Setting", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "ContractOwner", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerPool", "CustomerClaim", "EntMember", "EntDept"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  老板 = (await raw.user.create({ data: { email: "hc-boss@x.com", name: "老板", password: "x", role: "ADMIN" } })).id;
  const now = Date.now();
  for (let i = 0; i < 40; i++) {
    const c = await raw.customer.create({
      data: {
        name: `客户${i}`, phone: `137${String(i).padStart(8, "0")}`, salesOwnerId: 老板,
        followStatus: ["待跟进", "跟进中", "意向较高", "已签约"][i % 4],
        createdAt: new Date(now - (i * 3 + 1) * 天),
        lastFollowAt: i % 5 ? new Date(now - (i % 45) * 天) : null,
      },
    });
    if (i % 3) await raw.followUp.create({ data: { customerId: c.id, ownerId: 老板, type: "PHONE", title: `电话${i}`, content: "记录", occurredAt: new Date(now - (i % 60) * 天) } });
  }
});

afterEach(() => {
  for (const k of ["CRM_ENTERPRISE", "CRM_READ_POOL", "CRM_HOME_CACHE", "DESKTOP_LOCAL", "MULTI_TENANT"]) 设(k, 原环境[k]);
  清首页缓存();
});

afterAll(async () => {
  await 关读通道();
  await raw.$disconnect();
  process.env.DATABASE_URL = 临时.原连接串;
  fs.rmSync(临时.dir, { recursive: true, force: true });
});

const 新客户 = (名: string, 多久前: number, 状态 = "待跟进") =>
  raw.customer.create({ data: { name: 名, phone: `139${Math.random().toString().slice(2, 10)}`, salesOwnerId: 老板, followStatus: 状态, createdAt: new Date(Date.now() - 多久前), lastFollowAt: new Date(Date.now() - 多久前) } });

describe("库指纹", () => {
  it("只认绝对路径的 SQLite 文件", () => {
    expect(shm路径("file:/data/crm.db?connection_limit=1")).toBe("/data/crm.db-shm");
    expect(shm路径("file:./dev.db")).toBeNull();
    expect(shm路径("file:dev.db")).toBeNull();
    expect(shm路径("postgresql://x")).toBeNull();
    expect(shm路径("")).toBeNull();
    expect(库指纹("/no/such/file-shm")).toBeNull();
  });

  it("模型写、裸 SQL 写、交互式事务提交、另一个连接写都会变；只读不变", async () => {
    开();
    const 起 = 库指纹();
    expect(起).not.toBeNull();
    await prisma.customer.findMany({ take: 5 });
    await prisma.$queryRawUnsafe("SELECT count(*) AS n FROM Customer");
    await prisma.customer.count();
    expect(库指纹()).toBe(起);

    const c = await 新客户("指纹1", 天);
    const a = 库指纹();
    expect(a).not.toBe(起);

    await raw.$executeRawUnsafe(`UPDATE Customer SET name = '指纹1改' WHERE id = '${c.id}'`);
    const b = 库指纹();
    expect(b).not.toBe(a);

    await raw.$transaction(async (tx) => {
      await tx.customer.update({ where: { id: c.id }, data: { name: "指纹1再改" } });
      await tx.customer.findMany({ take: 1 });
    });
    const t = 库指纹();
    expect(t).not.toBe(b);

    // 别的连接（等于别的进程）写
    const 另 = new PrismaClient({ datasourceUrl: `${process.env.DATABASE_URL}?connection_limit=1` });
    try {
      await 另.customer.update({ where: { id: c.id }, data: { name: "别人改" } });
    } finally {
      await 另.$disconnect();
    }
    expect(库指纹()).not.toBe(t);
  });
});

describe("缓存着", () => {
  it("非企业版、CRM_HOME_CACHE=0 每次现数", async () => {
    设("CRM_ENTERPRISE", undefined);
    expect(首页缓存开着()).toBe(false);
    let n = 0;
    await 缓存着("k", async () => ++n);
    await 缓存着("k", async () => ++n);
    expect(n).toBe(2);
    开();
    关();
    expect(首页缓存开着()).toBe(false);
    await 缓存着("k", async () => ++n);
    expect(n).toBe(3);
  });

  it("同一份只数一次，同时来的共用一次；库一变立刻重数；key 不同各数各的", async () => {
    开();
    let n = 0;
    const 算 = async () => { n++; await 等(20); return n; };
    const [x, y, z] = await Promise.all([缓存着("k", 算), 缓存着("k", 算), 缓存着("k", 算)]);
    expect([x, y, z, n]).toEqual([1, 1, 1, 1]);
    expect(await 缓存着("k", 算)).toBe(1);
    expect(await 缓存着("k2", 算)).toBe(2);

    await 新客户("缓存作废", 天);
    expect(await 缓存着("k", 算)).toBe(3);
    expect(await 缓存着("k", 算)).toBe(3);
  });

  it("数的过程中有人提交：存下的是旧指纹，下一次重数", async () => {
    开();
    let n = 0;
    const 慢 = 缓存着("k", async () => { n++; await 新客户("数到一半", 天); return n; });
    expect(await 慢).toBe(1);
    expect(await 缓存着("k", async () => ++n)).toBe(2);
  });

  it("数失败不留", async () => {
    开();
    await expect(缓存着("k", async () => { throw new Error("坏了"); })).rejects.toThrow("坏了");
    expect(await 缓存着("k", async () => 7)).toBe(7);
  });
});

describe("对拍：开着缓存和关着一模一样，刚写的马上反映", () => {
  const 两边 = async <T,>(f: () => Promise<T>) => {
    开();
    关();
    const 现数 = await f();
    开();
    const 缓存 = await f();
    const 再取 = await f();
    return { 现数, 缓存, 再取 };
  };

  it("客户数", async () => {
    const now = dayjs();
    const 数 = () => 客户数(prisma, now, true);
    const r1 = await 两边(数);
    expect(r1.缓存).toEqual(r1.现数);
    expect(r1.再取).toEqual(r1.现数);

    // 改返回值不影响缓存里那份
    r1.再取.trend[0].created = -1;
    r1.再取.每周新增[0] = -1;
    expect(await 数()).toEqual(r1.现数);

    // 新建档 + 新跟进：缓存开着也马上数进去
    const c = await 新客户("刚建", 60_000);
    await raw.followUp.create({ data: { customerId: c.id, ownerId: 老板, type: "PHONE", title: "刚跟", content: "x", occurredAt: new Date(Date.now() - 60_000) } });
    const r2 = await 两边(数);
    expect(r2.缓存).toEqual(r2.现数);
    expect(r2.再取).toEqual(r2.现数);
    const 末 = (r: typeof r1.现数) => r.trend[r.trend.length - 1];
    expect(末(r2.现数).created).toBe(末(r1.现数).created + 1);
    expect(末(r2.现数).active).toBe(末(r1.现数).active + 1);
  });

  it("沉睡前几名（含别的几样的重叠）", async () => {
    const now = dayjs();
    const 边界 = 盯盘.沉睡边界(now)!;
    const 全部 = (await raw.customer.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((c) => c.id);
    const 别的客户 = 全部.filter((_, i) => i % 3 === 0);
    const 取 = () => 盯盘.沉睡前几名({ now, 边界, 前几名: 8, 别的客户 });
    const r1 = await 两边(取);
    expect(r1.缓存).toEqual(r1.现数);
    expect(r1.再取).toEqual(r1.现数);
    expect(r1.现数.沉睡).toBeGreaterThan(0);
    expect(r1.现数.重叠).toBeGreaterThan(0);
    r1.再取.ids.length = 0;
    expect(await 取()).toEqual(r1.现数);

    // 新的沉睡客户（跟进在 60 天前、高权重）：马上进总数、进前几名
    const c = await 新客户("刚睡着", 60 * 天, "意向较高");
    const r2 = await 两边(取);
    expect(r2.缓存).toEqual(r2.现数);
    expect(r2.现数.沉睡).toBe(r1.现数.沉睡 + 1);
    expect(r2.现数.ids).toContain(c.id);

    // 重叠不进缓存：别的客户换了照样准
    const 只它 = await 盯盘.沉睡前几名({ now, 边界, 前几名: 8, 别的客户: [c.id] });
    expect(只它.重叠).toBe(1);
    const 没有 = await 盯盘.沉睡前几名({ now, 边界, 前几名: 8, 别的客户: [] });
    expect(没有.重叠).toBe(0);
  });
});
