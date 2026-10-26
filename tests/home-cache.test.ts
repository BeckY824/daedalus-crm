/**
 * 首页重查询的短时缓存（lib/home-cache.ts）。钉的是：
 * - 库指纹（WAL 索引头）：任何提交都会变——模型写、裸 SQL 写、交互式事务提交、另一个连接 / 别的进程写；只读不变；
 *   取指纹不关 -shm（关了会丢 SQLite 的锁，别的进程写库时本进程 SIGBUS）
 * - 缓存着：同一份只数一次、同时来的共用一次；库一变下一次立刻重数；过了 30 秒库没变先给旧的、后台重数一份（失败接着给旧的、
 *   重数中被换掉的不覆盖），过期再满 30 秒不给旧的；数失败不留；最多 64 条、先淘汰最久没换的；
 *   非企业版 / CRM_HOME_CACHE=0 每次现数
 * - 指纹带 -shm 的 inode（-shm 删了重建，新头可能和旧头逐字相同）
 * - key：过了零点换一份；沉睡按 谁的 各一份；限定可见范围的人不走缓存
 * - 对拍：客户数、沉睡前几名、全部商机、近期待办开着缓存和关着结果一模一样；刚写进去的客户 / 跟进 / 商机 / 计划马上反映出来
 * 用拷出来的一份库（绝对路径，企业版开只读通道），不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
import { 关读通道, 读通道 } from "@/lib/read-pool";
import { 库指纹, shm路径, 缓存着, 首页缓存开着, 清首页缓存, 首页缓存条数 } from "@/lib/home-cache";
import { 客户数, 取行数, 全部商机 } from "@/lib/dashboard-sql";
import { 首页待办, 近期待办 } from "@/lib/dashboard-todo";
import { _内部 as 盯盘, loadWatchlistPage } from "@/lib/sentinel-data";
import { dayjs } from "@/lib/utils";
import { 可见客户 } from "@/lib/team-scope";
import nativeDayjs from "dayjs";
import { 今天零点 } from "@/lib/overdue";

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

  it("带上 -shm 的 inode：-shm 删了重建后头逐字相同也认得出", () => {
    const st = fs.statSync(shm路径()!);
    expect(库指纹()!.startsWith(`${st.dev}:${st.ino}:`)).toBe(true);
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

  // 取指纹要是 open/close -shm，会把本进程 SQLite 在 -shm 上的 fcntl 锁一起放掉；别的进程一打开库就以为没人在用，
  // 清空重建 -shm、退出时连 -wal/-shm 一起删——本进程 mmap 着的那块越界，整个进程 SIGBUS（压测时踩到）
  it("取指纹不关 -shm；别的进程写库，本进程的 -shm 不被重建、查询照常、指纹会变", async () => {
    开();
    const 库 = path.join(临时.dir, "H.db");
    await raw.customer.count();
    await prisma.customer.count();
    const 关过 = vi.spyOn(fs, "closeSync");
    const 原 = fs.statSync(`${库}-shm`);
    const 起 = 库指纹();
    const 写 = `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA busy_timeout = 5000"); db.prepare("UPDATE Customer SET name = name || '!' WHERE rowid = (SELECT min(rowid) FROM Customer)").run(); db.close();`;
    const 探锁 = `import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
try:
    fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB, 1, 128); print("free")
except OSError:
    print("held")`;
    try {
      for (let i = 0; i < 3; i++) {
        expect(库指纹()).not.toBeNull();
        const r = spawnSync(process.execPath, ["-e", 写, 库], { encoding: "utf8" });
        expect(r.status, r.stderr).toBe(0);
        const 现 = fs.statSync(`${库}-shm`);
        expect([现.ino, 现.dev]).toEqual([原.ino, 原.dev]);
        // SQLite「还有人在用」那把锁（-shm 第 128 字节的读锁）本进程还拿着：别的进程拿不到写锁
        const 探 = spawnSync("python3", ["-c", 探锁, `${库}-shm`], { encoding: "utf8" });
        // Windows 上没有 fcntl（python 里也没这个模块），-shm 的锁语义也不同：只在类 Unix 上探
        if (process.platform !== "win32" && !探.error) expect(探.stdout.trim(), 探.stderr).toBe("held");
        await prisma.customer.findMany({ take: 5 });
        await raw.customer.count();
      }
      expect(关过).not.toHaveBeenCalled();
    } finally {
      关过.mockRestore();
    }
    expect(库指纹()).not.toBe(起);
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

  // 控制 算 什么时候数完
  const 待定 = <T,>() => { let 好!: (v: T) => void, 坏!: (e: Error) => void; const p = new Promise<T>((r, j) => { 好 = r; 坏 = j; }); return { p, 好, 坏 }; };
  const 让一下 = () => 等(0);
  const 拨钟 = () => {
    const 起 = Date.now();
    const 钟 = vi.spyOn(Date, "now");
    const 到 = (ms: number) => 钟.mockReturnValue(起 + ms);
    到(0);
    return { 到, 还原: () => 钟.mockRestore() };
  };

  it("过了 30 秒库没变：先给旧的、后台重数一次，数好了下一次拿新的", async () => {
    开();
    const 钟 = 拨钟();
    try {
      let n = 0;
      const 下一份 = 待定<number>();
      const 算 = async () => (++n === 1 ? 1 : 下一份.p);
      expect(await 缓存着("k", 算)).toBe(1);
      钟.到(29_999);
      expect(await 缓存着("k", 算)).toBe(1);
      expect(n).toBe(1);
      钟.到(30_000);
      // 后台在数，这期间来的都拿旧的，也不再另起一份
      expect(await Promise.all([缓存着("k", 算), 缓存着("k", 算), 缓存着("k", 算)])).toEqual([1, 1, 1]);
      钟.到(31_000);
      expect(await 缓存着("k", 算)).toBe(1);
      expect(n).toBe(2);
      下一份.好(2);
      await 让一下();
      expect(await 缓存着("k", 算)).toBe(2);
      // 换上的那份从开始重数算起再活 30 秒
      钟.到(59_999);
      expect(await 缓存着("k", 算)).toBe(2);
      expect(n).toBe(2);
      钟.到(60_000);
      expect(await 缓存着("k", 算)).toBe(2);
      expect(n).toBe(3);
    } finally {
      钟.还原();
    }
  });

  it("过期又满 30 秒没人取：不给旧的，现数等它", async () => {
    开();
    const 钟 = 拨钟();
    try {
      let n = 0;
      const 算 = async () => ++n;
      expect(await 缓存着("k", 算)).toBe(1);
      钟.到(59_999);
      expect(await 缓存着("k", 算)).toBe(1);
      await 让一下();
      expect(n).toBe(2);
      清首页缓存();
      钟.到(0);
      expect(await 缓存着("k", 算)).toBe(3);
      钟.到(60_000);
      expect(await 缓存着("k", 算)).toBe(4);
    } finally {
      钟.还原();
    }
  });

  it("过期且库变了：不给旧的，现数等它", async () => {
    开();
    const 钟 = 拨钟();
    try {
      let n = 0;
      const 算 = async () => ++n;
      expect(await 缓存着("k", 算)).toBe(1);
      await 新客户("过期又变", 天);
      钟.到(30_000);
      expect(await 缓存着("k", 算)).toBe(2);
      expect(n).toBe(2);
    } finally {
      钟.还原();
    }
  });

  it("后台重数失败：接着给旧的，下一个人来再试", async () => {
    开();
    const 钟 = 拨钟();
    try {
      let n = 0;
      const 算 = async () => { n++; if (n === 2) throw new Error("坏了"); return n; };
      expect(await 缓存着("k", 算)).toBe(1);
      钟.到(30_000);
      expect(await 缓存着("k", 算)).toBe(1);
      await 让一下();
      expect(n).toBe(2);
      expect(await 缓存着("k", 算)).toBe(1);
      await 让一下();
      expect(n).toBe(3);
      expect(await 缓存着("k", 算)).toBe(3);
    } finally {
      钟.还原();
    }
  });

  it("还没数完的那份过期了：不当旧值给，现数", async () => {
    开();
    const 钟 = 拨钟();
    try {
      const 慢 = 待定<number>();
      let n = 0;
      const 算 = async () => (++n === 1 ? 慢.p : n);
      const 第一 = 缓存着("k", 算);
      钟.到(30_000);
      expect(await 缓存着("k", 算)).toBe(2);
      慢.好(1);
      expect(await 第一).toBe(1);
      expect(await 缓存着("k", 算)).toBe(2);
    } finally {
      钟.还原();
    }
  });

  it("后台重数的过程中库变了：有人现数换上了新的，后台数完的旧份不覆盖；没人换，存的是旧指纹、下一次重数", async () => {
    开();
    const 钟 = 拨钟();
    try {
      let n = 0;
      const 后台 = 待定<number>();
      const 算 = async () => (++n === 2 ? 后台.p : n);
      expect(await 缓存着("k", 算)).toBe(1);
      钟.到(30_000);
      expect(await 缓存着("k", 算)).toBe(1); // 起了后台（第 2 次）
      await 新客户("重数中变了", 天);
      expect(await 缓存着("k", 算)).toBe(3); // 库变了现数
      后台.好(2);
      await 让一下();
      expect(await 缓存着("k", 算)).toBe(3);

      // 没人现数：后台数到一半库变了，换上的那份带的是旧指纹
      清首页缓存();
      钟.到(0);
      n = 10;
      const 后台2 = 待定<number>();
      const 算2 = async () => (++n === 12 ? 后台2.p : n);
      expect(await 缓存着("k", 算2)).toBe(11);
      钟.到(30_000);
      expect(await 缓存着("k", 算2)).toBe(11);
      await 新客户("重数中变了2", 天);
      后台2.好(12);
      await 让一下();
      expect(await 缓存着("k", 算2)).toBe(13);
    } finally {
      钟.还原();
    }
  });

  it("最多 64 条，超了先淘汰最久没换的", async () => {
    开();
    let n = 0;
    const 算 = async () => ++n;
    for (let i = 0; i < 64; i++) await 缓存着(`k${i}`, 算);
    expect(首页缓存条数()).toBe(64);
    // 库变了，k0 重数一次：它成了最新换的那条
    await 新客户("淘汰顺序", 天);
    const 重数 = await 缓存着("k0", 算);
    expect(重数).toBe(65);
    await 缓存着("k64", 算);
    expect(首页缓存条数()).toBe(64);
    // 淘汰的是 k1（最久没换），k0 还在
    expect(await 缓存着("k0", 算)).toBe(重数);
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
    const 数 = () => 客户数(prisma, now, null);
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

  it("全部商机：改返回值不影响缓存；新商机、改阶段马上反映", async () => {
    const 客户 = (await raw.customer.findFirst({ select: { id: true } }))!.id;
    for (let i = 0; i < 6; i++) await raw.opportunity.create({ data: { name: `商机${i}`, customerId: 客户, ownerId: 老板, amount: 1000 * (i + 1), stage: ["初步沟通", "需求确认", "赢单成交"][i % 3], status: i % 3 === 2 ? "WON" : "OPEN" } });
    const 取 = () => 全部商机(prisma, true);
    const r1 = await 两边(取);
    expect(r1.现数).toHaveLength(6);
    expect(r1.缓存).toEqual(r1.现数);
    expect(r1.再取).toEqual(r1.现数);
    r1.再取.length = 0;
    expect(await 取()).toEqual(r1.现数);

    const o = await raw.opportunity.create({ data: { name: "刚建的商机", customerId: 客户, ownerId: 老板, amount: 99, stage: "初步沟通" } });
    await raw.opportunity.updateMany({ where: { name: "商机0" }, data: { stage: "需求确认" } });
    const r2 = await 两边(取);
    expect(r2.缓存).toEqual(r2.现数);
    expect(r2.再取).toEqual(r2.现数);
    expect(r2.现数).toHaveLength(7);
    expect(r2.现数.some((x) => x.amount === 99)).toBe(true);
    expect(r2.现数.filter((x) => x.stage === "需求确认")).toHaveLength(r1.现数.filter((x) => x.stage === "需求确认").length + 1);
    await raw.opportunity.delete({ where: { id: o.id } });
  });

  it("近期待办：改返回值不影响缓存；新计划、做完马上反映；限定的人不走缓存", async () => {
    const [甲, 乙] = await raw.customer.findMany({ select: { id: true, name: true }, take: 2, orderBy: { id: "asc" } });
    for (let i = 0; i < 4; i++) await raw.followPlan.create({ data: { subject: `计划${i}`, plannedAt: new Date(Date.now() + (i + 1) * 天), customerId: 甲.id, ownerId: 老板 } });
    await raw.task.create({ data: { title: "没排时间的待办", customerId: 乙.id, ownerId: 老板 } });
    const 取 = () => 首页待办(prisma, true);
    const r1 = await 两边(取);
    expect(r1.现数).toEqual(await 近期待办(prisma));
    expect(r1.现数).toHaveLength(5);
    expect(r1.缓存).toEqual(r1.现数);
    expect(r1.再取).toEqual(r1.现数);
    r1.再取[0].title = "改了";
    r1.再取.length = 1;
    expect(await 取()).toEqual(r1.现数);

    // 新计划排到最前、做完一条：缓存开着也马上换
    const 新 = await raw.followPlan.create({ data: { subject: "最急的", plannedAt: new Date(Date.now() + 3_600_000), customerId: 乙.id, ownerId: 老板 } });
    await raw.followPlan.updateMany({ where: { subject: "计划0" }, data: { done: true } });
    const r2 = await 两边(取);
    expect(r2.缓存).toEqual(r2.现数);
    expect(r2.再取).toEqual(r2.现数);
    expect(r2.现数[0]).toMatchObject({ id: `plan:${新.id}`, title: "最急的", customerName: 乙.name });
    expect(r2.现数.some((x) => x.title === "计划0")).toBe(false);

    // 限定（业务员）：现取，不进缓存
    const 限定 = {
      task: { findMany: async () => [] },
      followPlan: { findMany: async () => [] },
    } as unknown as typeof prisma;
    开();
    清首页缓存();
    expect(await 首页待办(限定, false)).toEqual([]);
    expect(首页缓存条数()).toBe(0);
    expect(await 首页待办(prisma, true)).toEqual(r2.现数);
  });

  it("首页接的是缓存那两个", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/dashboard/Board.tsx"), "utf8");
    expect(src).toMatch(/首页待办\(prisma, await 不限定\(\)\)/);
    expect(src).not.toMatch(/近期待办\(prisma/);
    expect(src).toMatch(/全部商机\(prisma, await 不限定\(\)\)/);
  });

  it("客户数：过了零点换一份，不拿昨天那份", async () => {
    const 今天 = dayjs();
    const 明天 = 今天.add(1, "day");
    开();
    const 今 = await 客户数(prisma, 今天, null);
    const 明 = await 客户数(prisma, 明天, null);
    关();
    expect(明).toEqual(await 客户数(prisma, 明天, null));
    expect(明).not.toEqual(今);
  });

  it("沉睡：过了零点换一份，各人各一份", async () => {
    const 业务员 = (await raw.user.create({ data: { email: "hc-sales@x.com", name: "业务员", password: "x", role: "USER" } })).id;
    await raw.customer.create({ data: { name: "业务员的", phone: "13600000001", salesOwnerId: 业务员, followStatus: "意向较高", createdAt: new Date(Date.now() - 70 * 天), lastFollowAt: new Date(Date.now() - 70 * 天) } });
    const 今天 = dayjs();
    const 明天 = 今天.add(1, "day");
    // 今天跟进满 13 天、明天满 14 天：明天才算沉睡，两天的结果不一样
    const 差一天 = 今天.subtract(13, "day").startOf("day").add(1, "hour").toDate();
    await raw.customer.create({ data: { name: "明天才睡", phone: "13600000003", salesOwnerId: 老板, followStatus: "意向较高", createdAt: 差一天, lastFollowAt: 差一天 } });
    const 取 = (now: typeof 今天, 谁的?: string) => 盯盘.沉睡前几名({ 谁的, now, 边界: 盯盘.沉睡边界(now)!, 前几名: 8, 别的客户: [] });
    开();
    const 全部今 = await 取(今天);
    const 全部明 = await 取(明天);
    const 只他 = await 取(今天, 业务员);
    关();
    expect(全部明).toEqual(await 取(明天));
    expect(只他).toEqual(await 取(今天, 业务员));
    expect(只他.沉睡).toBe(1);
    expect(全部今.沉睡).toBeGreaterThan(1);
    expect(全部明.沉睡).toBeGreaterThan(全部今.沉睡);
  });

  it("限定可见范围的人不走缓存：库里带范围数，和限定后的行算的一样，也不污染不限定的那份", async () => {
    const now = dayjs();
    const 业务员 = (await raw.user.findFirst({ where: { email: "hc-sales@x.com" } }))?.id
      ?? (await raw.user.create({ data: { email: "hc-sales@x.com", name: "业务员", password: "x", role: "USER" } })).id;
    await raw.customer.create({ data: { name: "限定的", phone: "13600000002", salesOwnerId: 业务员, followStatus: "待跟进", createdAt: new Date(Date.now() - 2 * 天) } });
    // 只看得到业务员那份客户的 db（代替 team-scope 那层 where），当基准
    const 限定 = {
      customer: { findMany: (q: object) => raw.customer.findMany({ ...q, where: 可见客户(业务员) }) },
      followUp: { findMany: (q: { where?: object }) => raw.followUp.findMany({ ...q, where: { ...q.where, customer: 可见客户(业务员) } }) },
    } as unknown as typeof prisma;
    开();
    const 全部 = await 客户数(prisma, now, null);
    清首页缓存();
    const 限定的 = await 客户数(prisma, now, 业务员);
    expect(首页缓存条数()).toBe(0);
    expect(限定的).toEqual(await 取行数(限定, now));
    expect(限定的).not.toEqual(全部);
    expect(await 客户数(prisma, now, null)).toEqual(全部);
  });

  it("盯盘名单：别的几样那份进缓存；改返回值不漏；新逾期计划、做完马上反映；各人、各天各一份", async () => {
    const now = dayjs();
    const 全部 = (await raw.customer.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((c) => c.id);
    for (let i = 0; i < 5; i++) await raw.followPlan.create({ data: { subject: `过期${i}`, plannedAt: new Date(Date.now() - (i + 1) * 天), customerId: 全部[i * 7], ownerId: 老板 } });
    for (let i = 0; i < 4; i++) {
      const 久 = new Date(Date.now() - (20 + i * 3) * 天);
      await raw.opportunity.create({ data: { name: `停了${i}`, customerId: 全部[i * 5 + 1], ownerId: 老板, updatedAt: 久, activityAt: 久 } });
    }
    const 取 = (谁的?: string, 哪天 = now) => loadWatchlistPage(哪天, 谁的 ? { ownerId: 谁的 } : {}, 0, 100);
    const r1 = await 两边(() => 取());
    expect(r1.缓存).toEqual(r1.现数);
    expect(r1.再取).toEqual(r1.现数);
    for (const kind of ["overdue_plan", "sleeping", "stalled_opp"]) expect(r1.现数.items.some((x) => x.kind === kind), kind).toBe(true);

    // 库没变再取：不再查计划表（企业版读走只读通道，盯它那一份）
    const 查计划 = vi.spyOn((读通道() ?? prisma).followPlan, "findMany");
    expect(await 取()).toEqual(r1.现数);
    expect(查计划).not.toHaveBeenCalled();
    查计划.mockRestore();

    // 改返回值不漏进缓存
    r1.再取.items[0].reason = "改了";
    r1.再取.items.length = 0;
    expect(await 取()).toEqual(r1.现数);

    // 新的逾期计划马上进、做完马上出
    const c = await 新客户("有过期计划", 2 * 天);
    const 计划 = await raw.followPlan.create({ data: { subject: "刚过期", plannedAt: new Date(Date.now() - 3 * 天), customerId: c.id, ownerId: 老板 } });
    const r2 = await 两边(() => 取());
    expect(r2.缓存).toEqual(r2.现数);
    expect(r2.现数.total).toBe(r1.现数.total + 1);
    expect(r2.现数.items.find((x) => x.customerId === c.id)?.kind).toBe("overdue_plan");
    await raw.followPlan.update({ where: { id: 计划.id }, data: { done: true } });
    const r3 = await 两边(() => 取());
    expect(r3.缓存).toEqual(r3.现数);
    expect(r3.现数).toEqual(r1.现数);

    // 各人一份
    const 业务员 = (await raw.user.findFirst({ where: { email: "hc-sales@x.com" } }))?.id
      ?? (await raw.user.create({ data: { email: "hc-sales@x.com", name: "业务员", password: "x", role: "USER" } })).id;
    const 他的 = await raw.customer.create({ data: { name: "业务员有计划", phone: "13600000004", salesOwnerId: 业务员, followStatus: "待跟进", createdAt: new Date(Date.now() - 3 * 天), lastFollowAt: new Date(Date.now() - 天) } });
    await raw.followPlan.create({ data: { subject: "他的过期", plannedAt: new Date(Date.now() - 2 * 天), customerId: 他的.id, ownerId: 业务员 } });
    const r4 = await 两边(() => 取(业务员));
    expect(r4.缓存).toEqual(r4.现数);
    expect(r4.现数.items.map((x) => x.customerId)).toContain(他的.id);
    const 他名下 = new Set((await raw.customer.findMany({ where: { salesOwnerId: 业务员 }, select: { id: true } })).map((x) => x.id));
    expect(r4.现数.items.every((x) => 他名下.has(x.customerId))).toBe(true);
    // 业务员那份不串给老板
    const 老板的 = await 两边(() => 取());
    expect(老板的.缓存).toEqual(老板的.现数);
    expect(老板的.现数.items.map((x) => x.customerId)).toContain(他的.id);
    expect(老板的.现数.items.some((x) => !他名下.has(x.customerId))).toBe(true);

    // 过了零点换一份：逾期天数跟着变
    const 明天 = now.add(1, "day");
    const r5 = await 两边(() => 取(undefined, 明天));
    expect(r5.缓存).toEqual(r5.现数);
    expect(r5.现数).not.toEqual(await 取());
  });

  it("盯盘名单：业务日（上海）过零点换一份；人在伦敦、伦敦过零点不影响", async () => {
    const 原TZ = process.env.TZ;
    process.env.TZ = "Europe/London";
    try {
      开(); // 企业版：业务日按上海，天数也按业务钟算
      const 上海零点 = dayjs(今天零点());
      const 伦敦零点 = nativeDayjs().startOf("day");
      expect(上海零点.valueOf()).not.toBe(伦敦零点.valueOf());
      // 上海今天零点前 2 小时约的：上海过了零点逾期天数 +1
      const c = await 新客户("零点前约的", 2 * 天);
      await raw.followPlan.create({ data: { subject: "零点前", plannedAt: 上海零点.subtract(2, "hour").toDate(), customerId: c.id, ownerId: 老板 } });
      const 取 = (now: number) => loadWatchlistPage(dayjs(now), {}, 0, 100);
      const 理由 = (r: Awaited<ReturnType<typeof 取>>) => r.items.find((x) => x.customerId === c.id)?.reason;
      for (const [零点, 该变] of [[上海零点.valueOf(), true], [伦敦零点.valueOf(), false]] as const) {
        const 前 = 零点 - 30 * 60_000, 后 = 零点 + 30 * 60_000;
        开();
        const 缓存前 = await 取(前);
        const 缓存后 = await 取(后);
        关();
        expect(缓存前).toEqual(await 取(前));
        expect(缓存后).toEqual(await 取(后));
        if (该变) expect(理由(缓存后)).not.toBe(理由(缓存前));
        else expect(理由(缓存后)).toBe(理由(缓存前));
      }
    } finally {
      process.env.TZ = 原TZ;
    }
  });
});
