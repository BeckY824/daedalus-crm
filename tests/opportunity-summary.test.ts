/**
 * 商机列表汇总药丸改成库里按币种加（lib/opportunity-summary.ts，2026-10-25），和原来取行在 JS 里加的写法对拍。
 *
 * 取行汇总 就是列表页原来那一段，当基准。两边吃同一个库：
 *   - 币种：人民币 / 美元 / 小写 usd / 前后带空格 / 认不得的码 / 没有币种那一行（老数据）都有，规整后要合成同一组
 *   - 状态：进行中 / 赢单 / 输单；不筛、按状态、按阶段、按负责人、组合筛
 *   - 带小数的金额、0 金额、赢单率 0 和 100
 *   - 金额相同的几个币种谁排前面（按第一次出现）
 *   - 空库、筛完一行都没有
 *   - 按关键词、限定了、参数是数组：不走裸 SQL
 * 库拷自测试库到临时目录，不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient, type Prisma } from "@/generated/prisma";
import { 商机汇总, 取行汇总, type 汇总筛选 } from "@/lib/opportunity-summary";

const 测试库 = path.resolve(__dirname, "../prisma/test.db");
let 目录: string;
let db: PrismaClient;
let 甲 = "";
let 乙 = "";
let 客户 = "";

beforeAll(async () => {
  目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-opp-sum-"));
  const f = path.join(目录, "t.db");
  fs.copyFileSync(测试库, f);
  if (fs.existsSync(`${测试库}-wal`)) fs.copyFileSync(`${测试库}-wal`, `${f}-wal`);
  db = new PrismaClient({ datasourceUrl: `file:${f}?connection_limit=1` });
  await db.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  // 清库按表序删，Windows 上留着别的测试写的外键引用会卡住；这是只属于本测试的一份拷贝，关掉外键检查
  await db.$executeRawUnsafe("PRAGMA foreign_keys = OFF");
  for (const t of ["AiConversation", "AiProject", "AuditLog", "ImportBatch", "FollowUpOrder", "TradeOrderDoc", "TradeOrderNode", "TradeOrderPurchase", "TradeOrder", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "ContractOwner", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerPool", "CustomerClaim"]) {
    await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
  }
  await db.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "User"]) await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
  甲 = (await db.user.create({ data: { email: "opp-sum-a", name: "甲", role: "ADMIN", password: "x" } })).id;
  乙 = (await db.user.create({ data: { email: "opp-sum-b", name: "乙", role: "USER", password: "x" } })).id;
  客户 = (await db.customer.create({ data: { name: "汇总客户", school: "某公司", phone: "13600000009", salesOwnerId: 甲 } })).id;
});

afterAll(async () => {
  await db?.$disconnect();
  fs.rmSync(目录, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** 固定种子的伪随机数：失败时能原样复现 */
function 随机(种子: number) {
  let s = 种子 >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const 阶段 = ["初步沟通", "需求确认", "方案报价", "谈判审核", "赢单成交"];
const 状态 = ["OPEN", "OPEN", "OPEN", "WON", "LOST"];
/** undefined = 不写 OpportunityMoney 那一行（0.46.15 之前的老数据） */
const 币种 = ["CNY", "USD", "usd", " eur ", "XYZ", "", undefined, "CNY", "USD", "GBP"];

async function 灌(种子: number, 个数: number) {
  await db.$executeRawUnsafe('DELETE FROM "Opportunity"');
  const r = 随机(种子);
  const 挑 = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  for (let i = 0; i < 个数; i++) {
    const 金额 = r() < 0.1 ? 0 : r() < 0.5 ? Math.round(r() * 1e6) / 100 : Math.floor(r() * 50000);
    const o = await db.opportunity.create({
      data: { name: `商机${i}`, amount: 金额, stage: 挑(阶段), status: 挑(状态), probability: 挑([0, 10, 33, 50, 77, 100]), customerId: 客户, ownerId: r() < 0.6 ? 甲 : 乙 },
    });
    const c = 挑(币种);
    if (c !== undefined) await db.opportunityMoney.create({ data: { opportunityId: o.id, currency: c } });
  }
}

/** 页面上拼 where 的那段，原样抄过来（不含关键词） */
function 拼(筛: 汇总筛选): Prisma.OpportunityWhereInput {
  return {
    ...(筛.stage ? { stage: 筛.stage } : {}),
    ...(筛.status ? { status: 筛.status } : {}),
    ...(筛.ownerId ? { ownerId: 筛.ownerId } : {}),
  };
}

async function 对拍(筛: 汇总筛选) {
  const where = 拼(筛);
  const 旧 = await 取行汇总(db, where, Boolean(筛.status));
  const 新 = await 商机汇总(db, where, 筛, true);
  const 标 = JSON.stringify(筛);
  expect(新.单数, 标).toBe(旧.单数);
  for (const k of ["合计", "预测"] as const) {
    expect(新[k].map((x) => x.币种), `${标} ${k}`).toEqual(旧[k].map((x) => x.币种));
    新[k].forEach((x, i) => expect(x.合计, `${标} ${k} ${x.币种}`).toBeCloseTo(旧[k][i].合计, 6));
  }
  return 新;
}

function 各种筛法(): 汇总筛选[] {
  const out: 汇总筛选[] = [{}, { status: "" }, { stage: "" }];
  for (const s of ["OPEN", "WON", "LOST", "没有这个"]) out.push({ status: s });
  for (const g of 阶段) out.push({ stage: g }, { stage: g, status: "WON" });
  for (const o of [甲, 乙, "没有这个人"]) out.push({ ownerId: o }, { ownerId: o, status: "LOST" }, { ownerId: o, stage: 阶段[2] });
  out.push({ stage: 阶段[0], status: "OPEN", ownerId: 乙 });
  return out;
}

describe("商机汇总：库里按币种加和取行在 JS 里加对拍", () => {
  it("空库", async () => {
    await db.$executeRawUnsafe('DELETE FROM "Opportunity"');
    for (const 筛 of 各种筛法()) expect(await 对拍(筛)).toEqual({ 单数: 0, 合计: [], 预测: [] });
  });

  for (const 种子 of [1, 7, 42]) {
    it(`随机 300 个商机（种子 ${种子}）`, async () => {
      await 灌(种子, 300);
      const 不筛 = await 对拍({});
      // 规整以后合成一组：小写 usd、带空格的 eur、认不得的和没有币种的都在里面
      expect(不筛.合计.map((x) => x.币种).sort()).toEqual(["CNY", "EUR", "GBP", "USD"]);
      expect(不筛.预测.length).toBeGreaterThan(0);
      for (const 筛 of 各种筛法()) await 对拍(筛);
      // 筛了赢单 / 输单，预测一行都没有（原来是在取回来的行里挑进行中的）
      expect((await 对拍({ status: "WON" })).预测).toEqual([]);
    });
  }

  it("金额相同的币种按第一次出现排", async () => {
    await db.$executeRawUnsafe('DELETE FROM "Opportunity"');
    for (const [i, c] of ["USD", "GBP", "cny", "EUR", "usd"].entries()) {
      const o = await db.opportunity.create({ data: { name: `平${i}`, amount: 0, probability: 50, customerId: 客户, ownerId: 甲 } });
      await db.opportunityMoney.create({ data: { opportunityId: o.id, currency: c } });
    }
    const o = await db.opportunity.create({ data: { name: "老数据", amount: 0, customerId: 客户, ownerId: 甲 } });
    expect(o.id).toBeTruthy();
    const 新 = await 对拍({});
    expect(新.合计.map((x) => x.币种)).toEqual(["USD", "GBP", "CNY", "EUR"]);
    expect(新.单数).toBe(6);
  });

  /** 依次建进行中的商机；币种 undefined = 不写 OpportunityMoney 那一行（老数据） */
  async function 依次建(行: [币种: string | undefined, 金额: number, 赢单率: number][]) {
    await db.$executeRawUnsafe('DELETE FROM "Opportunity"');
    for (const [i, [c, amount, probability]] of 行.entries()) {
      const o = await db.opportunity.create({ data: { name: `并${i}`, amount, probability, customerId: 客户, ownerId: 甲 } });
      if (c !== undefined) await db.opportunityMoney.create({ data: { opportunityId: o.id, currency: c } });
    }
  }

  it("金额不为零且相同：合计、预测都按第一次出现排，小写币种排在最前也一样", async () => {
    // 合计四个币种都是 300；预测 EUR 300 最大，其余三个都是 150
    await 依次建([
      ["usd", 300, 50],
      [undefined, 300, 50],
      ["GBP", 100, 50],
      ["EUR", 300, 100],
      ["GBP", 200, 50],
    ]);
    for (const 筛 of [{}, { status: "OPEN" }]) {
      const 新 = await 对拍(筛);
      expect(新.合计).toEqual([{ 币种: "USD", 合计: 300 }, { 币种: "CNY", 合计: 300 }, { 币种: "GBP", 合计: 300 }, { 币种: "EUR", 合计: 300 }]);
      expect(新.预测).toEqual([{ 币种: "EUR", 合计: 300 }, { 币种: "USD", 合计: 150 }, { 币种: "CNY", 合计: 150 }, { 币种: "GBP", 合计: 150 }]);
    }
  });

  it("没有币种的老数据排在最前：和后面小写 cny 合成一组，排位按老数据那一行", async () => {
    // 库里没币种的和 cny 是两组（rowid 1、3），合起来后按 1 排；合计、预测三个币种都并列
    await 依次建([
      [undefined, 100, 100],
      ["USD", 300, 50],
      ["cny", 200, 25],
      ["EUR", 300, 50],
    ]);
    const 新 = await 对拍({});
    expect(新.合计).toEqual([{ 币种: "CNY", 合计: 300 }, { 币种: "USD", 合计: 300 }, { 币种: "EUR", 合计: 300 }]);
    expect(新.预测).toEqual([{ 币种: "CNY", 合计: 150 }, { 币种: "USD", 合计: 150 }, { 币种: "EUR", 合计: 150 }]);
    expect(新.单数).toBe(4);
  });

  it("按关键词、限定了、参数是数组都走原来那条路，不发裸 SQL", async () => {
    await 灌(3, 40);
    const 裸 = vi.spyOn(db, "$queryRawUnsafe");
    try {
      await 商机汇总(db, { name: { contains: "商机1" } }, { 关键词: "商机1" }, true);
      await 商机汇总(db, {}, {}, false);
      await 商机汇总(db, { status: { in: ["OPEN", "WON"] } }, { status: ["OPEN", "WON"] as unknown as string }, true).catch(() => undefined);
      expect(裸).not.toHaveBeenCalled();
      await 商机汇总(db, {}, {}, true);
      expect(裸).toHaveBeenCalledTimes(1);
    } finally {
      裸.mockRestore();
    }
    // 关键词那条路的结果和直接取行一样
    const where = { name: { contains: "商机1" } };
    expect(await 商机汇总(db, where, { 关键词: "商机1" }, true)).toEqual(await 取行汇总(db, where, false));
  });

  it("页面：不限定才走库里，筛选参数和 where 同一组", () => {
    const 源 = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/opportunities/page.tsx"), "utf8");
    expect(源).toMatch(/商机汇总\(prisma, where, \{ 关键词: 词, stage: sp\.stage, status: sp\.status, ownerId: sp\.ownerId \}, !\(await 限定的我\(defaultClient\)\)\)/);
    expect(源).toMatch(/\.\.\.\(sp\.stage \? \{ stage: sp\.stage \} : \{\}\),\n\s+\.\.\.\(sp\.status \? \{ status: sp\.status \} : \{\}\),\n\s+\.\.\.\(sp\.ownerId \? \{ ownerId: sp\.ownerId \} : \{\}\),/);
  });
});
