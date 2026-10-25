/**
 * 跟进计划页轻列表的短时缓存（lib/plans-page.ts 取计划页 的 共用、lib/plans-light.ts 压轻 只压一次）。钉的是：
 * - 对拍：开着缓存和关着，取计划页给的 plans / tasks / 轻 / 负责人一模一样；不同的人共用一份轻列表，「我的」那组照各自挑
 * - 刚写的马上反映：新建计划、做完、改负责人、新建待办，下一次就是新的
 * - 限定可见范围的人（页面不传 共用）不走缓存，取的是限定后的行
 * - 压轻：同一份轻列表只压一次，压出来和现压的一样
 * - 页面接的是 限定的我
 * 用拷出来的一份库（绝对路径，企业版开只读通道），不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-plans-cache-"));
  const 原连接串 = process.env.DATABASE_URL;
  fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(dir, "P.db"));
  if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(dir, "P.db-wal"));
  process.env.DATABASE_URL = `file:${path.join(dir, "P.db")}`;
  return { dir, 原连接串 };
});

import { prisma, defaultClient as raw } from "@/lib/prisma";
import { 关读通道 } from "@/lib/read-pool";
import { 缓存着, 清首页缓存, 首页缓存条数 } from "@/lib/home-cache";
import { 取计划页, type 计划页 } from "@/lib/plans-page";
import { 压轻 } from "@/lib/plans-light";
import { 读每组 } from "@/lib/plans-groups";

const 原环境 = { ...process.env };
const 设 = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
const 开 = () => { 设("CRM_ENTERPRISE", "1"); 设("CRM_READ_POOL", undefined); 设("CRM_HOME_CACHE", undefined); };
const 关 = () => 设("CRM_HOME_CACHE", "0");
const 天 = 86_400_000;
const 每组 = 读每组(undefined);

let 老板 = "";
let 业务员 = "";
let 客户 = "";

beforeAll(async () => {
  设("DESKTOP_LOCAL", undefined);
  设("MULTI_TENANT", undefined);
  for (const t of ["AiConversation", "AiProject", "Setting", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "ContractOwner", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerPool", "CustomerClaim", "EntMember", "EntDept"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  老板 = (await raw.user.create({ data: { email: "pc-boss@x.com", name: "老板", password: "x", role: "ADMIN" } })).id;
  业务员 = (await raw.user.create({ data: { email: "pc-sales@x.com", name: "业务员", password: "x", role: "USER" } })).id;
  客户 = (await raw.customer.create({ data: { name: "客户", phone: "13600000001", salesOwnerId: 老板 } })).id;
  const now = Date.now();
  // 每组 50 条摆不下：逾期、以后两组各一大片，同一时刻的也有，带只有日期的
  await raw.followPlan.createMany({
    data: Array.from({ length: 360 }, (_, i) => {
      const d = new Date(now + (i % 2 ? 1 : -1) * (1 + (i % 40)) * 天 + (i % 7 ? i * 60_000 : 0));
      return { id: `cp${i}`, subject: `计划${i}`, plannedAt: d, plannedOn: i % 5 ? null : d.toISOString().slice(0, 10), customerId: 客户, ownerId: i % 3 ? 老板 : 业务员 };
    }),
  });
  await raw.task.createMany({
    data: Array.from({ length: 80 }, (_, i) => ({ id: `ct${i}`, title: `待办${i}`, dueAt: i % 4 ? new Date(now + (i - 20) * 3_600_000) : null, customerId: 客户, ownerId: i % 2 ? 老板 : 业务员 })),
  });
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

/** 关着缓存现取一份 */
async function 现取(me: string): Promise<计划页> {
  关();
  const 页 = await 取计划页(prisma, 每组, me, 缓存着);
  设("CRM_HOME_CACHE", undefined);
  return 页;
}

describe("取计划页：不限定时轻列表走短时缓存", () => {
  it("开着缓存和关着一模一样；两个人共用一份轻列表，「我的」照各自挑", async () => {
    const 老板的 = await 现取(老板);
    const 业务员的 = await 现取(业务员);
    expect(首页缓存条数()).toBe(0);
    expect(老板的.轻!.length).toBe(440);
    expect(老板的.plans.length + 老板的.tasks.length).toBeLessThan(440);

    开();
    const 一 = await 取计划页(prisma, 每组, 老板, 缓存着);
    const 二 = await 取计划页(prisma, 每组, 业务员, 缓存着);
    const 三 = await 取计划页(prisma, 每组, 老板, 缓存着);
    expect(首页缓存条数()).toBe(1);
    expect(一).toEqual(老板的);
    expect(二).toEqual(业务员的);
    expect(三).toEqual(老板的);
    expect(二.plans).not.toEqual(一.plans);
    // 共用的是同一份（压轻靠它只压一次）
    expect(二.轻).toBe(一.轻);
    expect(三.负责人).toBe(一.负责人);
  });

  it("刚写的马上反映：新建计划、做完、改负责人、新建待办", async () => {
    开();
    await 取计划页(prisma, 每组, 老板, 缓存着);
    const 写们: (() => Promise<unknown>)[] = [
      () => raw.followPlan.create({ data: { id: "cp-new", subject: "最急的", plannedAt: new Date(Date.now() - 100 * 天), customerId: 客户, ownerId: 业务员 } }),
      () => raw.followPlan.update({ where: { id: "cp1" }, data: { done: true, doneAt: new Date() } }),
      () => raw.followPlan.update({ where: { id: "cp4" }, data: { ownerId: 业务员 } }),
      () => raw.task.create({ data: { id: "ct-new", title: "新待办", dueAt: new Date(Date.now() - 50 * 天), customerId: 客户, ownerId: 老板 } }),
    ];
    for (const 写 of 写们) {
      await 写();
      const 缓存的 = await 取计划页(prisma, 每组, 业务员, 缓存着);
      expect(缓存的).toEqual(await 现取(业务员));
    }
    const 末 = await 取计划页(prisma, 每组, 业务员, 缓存着);
    expect(末.轻!.map(([k]) => k)).toEqual(expect.arrayContaining(["plan:cp-new", "task:ct-new"]));
    expect(末.轻!.some(([k]) => k === "plan:cp1")).toBe(false);
    expect(末.plans.some((p) => p.id === "cp-new")).toBe(true);
  });

  it("限定可见范围的人不走缓存：取的是限定后的行，也不污染不限定的那份", async () => {
    // 只看得到业务员自己名下的 db（代替 team-scope 那层 where）
    const 限定 = {
      followPlan: { findMany: (q: { where?: object }) => raw.followPlan.findMany({ ...q, where: { ...q.where, ownerId: 业务员 } }) },
      task: { findMany: (q: { where?: object }) => raw.task.findMany({ ...q, where: { ...q.where, ownerId: 业务员 } }) },
    } as unknown as typeof prisma;
    开();
    const 全部 = await 取计划页(prisma, 每组, 老板, 缓存着);
    清首页缓存();
    const 限定的 = await 取计划页(限定, 每组, 业务员);
    expect(首页缓存条数()).toBe(0);
    expect(限定的.负责人 ?? [业务员]).toEqual([业务员]);
    expect(await 取计划页(prisma, 每组, 老板, 缓存着)).toEqual(全部);
  });

  it("个人版（缓存不开）：每次现取，照原来", async () => {
    设("CRM_ENTERPRISE", undefined);
    const 页 = await 取计划页(prisma, 每组, 老板, 缓存着);
    expect(首页缓存条数()).toBe(0);
    expect(页).toEqual(await 现取(老板));
  });
});

describe("压轻：同一份轻列表只压一次", () => {
  it("同一个数组再压给同一个结果，和现压的一样；换了负责人就重压", async () => {
    开();
    const 页 = await 取计划页(prisma, 每组, 老板, 缓存着);
    const 紧 = 压轻(页.轻!, 页.负责人!);
    expect(紧).not.toBeNull();
    expect(压轻((await 取计划页(prisma, 每组, 业务员, 缓存着)).轻!, 页.负责人!)).toBe(紧);
    const 拷 = 页.轻!.map((x) => [...x] as typeof x);
    const 现压的 = 压轻(拷, [...页.负责人!]);
    expect(现压的).not.toBe(紧);
    expect(现压的).toEqual(紧);
    expect(压轻(页.轻!, ["别的"])).not.toBe(紧);
  });
});

describe("页面接线", () => {
  it("跟进计划页按 限定的我 判不限定", () => {
    const 源 = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/follow-ups/plans/page.tsx"), "utf8");
    expect(源).toMatch(/取计划页\(prisma, 每组, me\.id, \(await 限定的我\(defaultClient\)\) \? undefined : 缓存着\)/);
  });
});
