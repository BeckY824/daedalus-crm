/**
 * 商机管道轻查询的短时缓存（lib/pipeline-page.ts 取管道 的 共用）。钉的是：
 * - 对拍：开着缓存和关着，取管道给的 rows / 列 / 总条数 / 负责人一模一样
 *   起 不在整点上、赢单的结单时刻 / 老数据的 updatedAt 正好卡在 起底、起 前后 1 毫秒，分批和整取两条路都测
 * - 同一个整点里不同的 起 共用一份（缓存只多一条），各自筛得对
 * - 刚写的马上反映：新赢单、赢单改丢单、改金额
 * - 限定可见范围的人（页面不传 共用）不走缓存
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-pipe-cache-"));
  const 原连接串 = process.env.DATABASE_URL;
  fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(dir, "P.db"));
  if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(dir, "P.db-wal"));
  process.env.DATABASE_URL = `file:${path.join(dir, "P.db")}`;
  return { dir, 原连接串 };
});

import { prisma, defaultClient as raw } from "@/lib/prisma";
import { 关读通道 } from "@/lib/read-pool";
import { 缓存着, 清首页缓存, 首页缓存条数 } from "@/lib/home-cache";
import { 取管道, type 管道页 } from "@/lib/pipeline-page";
import { OPP_STAGES } from "@/lib/constants";
import { 读每列, 写每列 } from "@/lib/pipeline-columns";

const 原环境 = { ...process.env };
const 设 = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
const 开 = () => { 设("CRM_ENTERPRISE", "1"); 设("CRM_READ_POOL", undefined); 设("CRM_HOME_CACHE", undefined); };
const 关 = () => 设("CRM_HOME_CACHE", "0");
const 时 = 3_600_000;
const 天 = 24 * 时;

/** 起 不在整点上；起底 是它往前的整点 */
const 起 = new Date(Date.parse("2026-09-24T08:37:12.345Z"));
const 起底 = Date.parse("2026-09-24T08:00:00.000Z");
const 卡点 = [起底 - 1, 起底, 起底 + 1, 起.getTime() - 1, 起.getTime(), 起.getTime() + 1, 起.getTime() + 5 * 天, 起底 - 5 * 天];

let 甲 = "";
let 乙 = "";
let 客户 = "";

beforeAll(async () => {
  设("DESKTOP_LOCAL", undefined);
  设("MULTI_TENANT", undefined);
  for (const t of ["AiConversation", "AiProject", "Setting", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "ContractOwner", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerPool", "CustomerClaim", "EntMember", "EntDept"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  甲 = (await raw.user.create({ data: { email: "pp-a@x.com", name: "甲", password: "x", role: "ADMIN" } })).id;
  乙 = (await raw.user.create({ data: { email: "pp-b@x.com", name: "乙", password: "x", role: "USER" } })).id;
  客户 = (await raw.customer.create({ data: { name: "客户", phone: "13600000002", salesOwnerId: 甲 } })).id;
  // 第一列 80 张摆不下（走分批），其余几列不到一批；同金额一大片
  const 进行中 = OPP_STAGES.flatMap((s, k) => Array.from({ length: [80, 12, 3, 0, 1][k] }, (_, i) => ({ id: `po${k}-${i}`, stage: s })));
  await raw.opportunity.createMany({
    data: [
      ...进行中.map((o, i) => ({ id: o.id, name: `商机${o.id}`, amount: [0, 100, 100, 2500][i % 4] + (i % 7 ? 0 : i), stage: o.stage, status: "OPEN", customerId: 客户, ownerId: i % 3 ? 甲 : 乙 })),
      { id: "po-old", name: "老阶段", amount: 5, stage: "老阶段", status: "OPEN", customerId: 客户, ownerId: 乙 },
      // 赢单：有结单时刻的 / 老数据没有、靠 updatedAt；丢单的同样卡点，永远不该出来
      ...卡点.flatMap((t, i) => [
        { id: `pw${i}`, name: `赢${i}`, amount: 100, stage: "赢单成交", status: "WON", customerId: 客户, ownerId: 甲 },
        { id: `pu${i}`, name: `老赢${i}`, amount: 100 + i, stage: "赢单成交", status: "WON", customerId: 客户, ownerId: 乙 },
        { id: `pl${i}`, name: `丢${i}`, amount: 100, stage: "需求确认", status: "LOST", customerId: 客户, ownerId: 甲 },
      ]),
    ],
  });
  await raw.opportunityClose.createMany({ data: 卡点.flatMap((t, i) => [{ opportunityId: `pw${i}`, closedAt: new Date(t) }, { opportunityId: `pl${i}`, closedAt: new Date(t) }]) });
  await raw.opportunityMoney.createMany({ data: 进行中.filter((_, i) => i % 5 === 1).map((o, i) => ({ opportunityId: o.id, currency: ["USD", "eur", "XYZ"][i % 3] })) });
  for (const [i, t] of 卡点.entries()) {
    await raw.$executeRawUnsafe(`UPDATE Opportunity SET updatedAt = ? WHERE id IN (?, ?)`, t, `pu${i}`, `pl${i}`);
    // 有结单时刻的 updatedAt 故意放在 30 天里：不能拿它代替结单时刻
    await raw.$executeRawUnsafe(`UPDATE Opportunity SET updatedAt = ? WHERE id = ?`, 起.getTime() + 天 - t + 起底, `pw${i}`);
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

const 分批 = 读每列(undefined);
const 整取 = 读每列(写每列({ ...读每列(undefined), [OPP_STAGES[0]]: 200 }));

/** 关着缓存现取一份（和改之前一样：不传 共用 也是这条路） */
async function 现取(at: Date, 每列: Record<string, number>, 新?: string): Promise<管道页> {
  关();
  const 页 = await 取管道(prisma, at, 每列, 新, 缓存着);
  设("CRM_HOME_CACHE", undefined);
  expect(await 取管道(prisma, at, 每列, 新)).toEqual(页);
  return 页;
}

describe("取管道：不限定时轻查询走短时缓存", () => {
  it("开着缓存和关着一模一样：分批、整取、带刚新建的", async () => {
    for (const [每列, 新] of [[分批, undefined], [分批, "po0-79,po0-3"], [整取, undefined]] as const) {
      const 原 = await 现取(起, 每列, 新);
      开();
      expect(await 取管道(prisma, 起, 每列, 新, 缓存着)).toEqual(原);
      expect(await 取管道(prisma, 起, 每列, 新, 缓存着)).toEqual(原);
      expect(首页缓存条数()).toBe(1);
      清首页缓存();
    }
    // 卡点上的赢单真的有进有出（不然上面对拍测不出筛没筛）
    const 页 = await 现取(起, 分批);
    const 赢 = 页.rows.filter((r) => r.status === "WON").map((r) => r.id).sort();
    expect(赢).toEqual(["pu4", "pu5", "pu6", "pw4", "pw5", "pw6"]);
    expect(页.列).toBeDefined();
  });

  it("同一个整点里的不同 起 共用一份，各自筛得对；整点上的 起 不用再问", async () => {
    const 们 = [起, new Date(起底), new Date(起底 + 1), new Date(起.getTime() + 1), new Date(起底 + 时 - 1)];
    const 原 = [];
    for (const at of 们) 原.push(await 现取(at, 分批));
    开();
    for (const [i, at] of 们.entries()) expect(await 取管道(prisma, at, 分批, undefined, 缓存着)).toEqual(原[i]);
    expect(首页缓存条数()).toBe(1);
    // 跨整点就是另一份
    const 下一点 = new Date(起底 + 时);
    const 原下 = await 现取(下一点, 分批);
    开();
    expect(await 取管道(prisma, 下一点, 分批, undefined, 缓存着)).toEqual(原下);
    expect(首页缓存条数()).toBe(2);
  });

  it("刚写的马上反映：新赢单、赢单改丢单、改金额", async () => {
    开();
    await 取管道(prisma, 起, 分批, undefined, 缓存着);
    const 写们: (() => Promise<unknown>)[] = [
      () => raw.opportunity.update({ where: { id: "po0-10" }, data: { status: "WON", stage: "赢单成交", closed: { create: { closedAt: new Date(起.getTime() + 时) } } } }),
      () => raw.opportunity.update({ where: { id: "pw5" }, data: { status: "LOST" } }),
      () => raw.opportunity.update({ where: { id: "po0-20" }, data: { amount: 1e9 } }),
      () => raw.opportunity.update({ where: { id: "po0-11" }, data: { status: "WON", stage: "赢单成交", closed: { create: { closedAt: new Date(起底 + 1) } } } }),
    ];
    for (const 写 of 写们) {
      await 写();
      开();
      const 缓存的 = await 取管道(prisma, 起, 分批, undefined, 缓存着);
      expect(缓存的).toEqual(await 现取(起, 分批));
    }
    const 末 = await 现取(起, 分批);
    expect(末.rows.some((r) => r.id === "po0-10")).toBe(true);
    expect(末.rows.some((r) => r.id === "po0-11" || r.id === "pw5")).toBe(false);
    expect(末.rows[0].id).toBe("po0-20");
  });

  it("限定可见范围的人不走缓存：取的是限定后的行，也不污染不限定的那份", async () => {
    // 只看得到乙名下的 db（代替 team-scope 那层 where）
    const 限定 = {
      opportunity: { findMany: (q: { where?: object }) => raw.opportunity.findMany({ ...q, where: { AND: [q.where ?? {}, { ownerId: 乙 }] } }) },
    } as unknown as typeof prisma;
    开();
    const 全部 = await 取管道(prisma, 起, 分批, undefined, 缓存着);
    清首页缓存();
    const 限定的 = await 取管道(限定, 起, 分批);
    expect(首页缓存条数()).toBe(0);
    expect(限定的.rows.every((r) => r.ownerId === 乙)).toBe(true);
    expect(限定的.负责人 ?? [乙]).toEqual([乙]);
    expect(await 取管道(prisma, 起, 分批, undefined, 缓存着)).toEqual(全部);
  });

  it("个人版（缓存不开）：每次现取，照原来", async () => {
    设("CRM_ENTERPRISE", undefined);
    const 页 = await 取管道(prisma, 起, 分批, undefined, 缓存着);
    expect(首页缓存条数()).toBe(0);
    expect(页).toEqual(await 现取(起, 分批));
  });
});

describe("页面接线", () => {
  it("商机管道页按 限定的我 判不限定", () => {
    const 源 = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/opportunities/pipeline/page.tsx"), "utf8");
    expect(源).toMatch(/取管道\(prisma, 起, 每列, 读新\(sp\.new\), \(await 限定的我\(defaultClient\)\) \? undefined : 缓存着\)/);
  });
});
