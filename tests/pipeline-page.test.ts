/**
 * 商机管道分批取（lib/pipeline-page.ts、lib/pipeline-columns.ts，2026-10-24 企业版压测）和原来「全取回来画」对拍：
 *
 *   - 列头条数、按币种合计：每列都和原来在全部行上算的一模一样（不管这列取回来几张）
 *   - 「再看 50 条」一直点到底：每列取回来的正好是全部、顺序是金额从大到小（同金额按 id）
 *   - 每列不到 50 张（个人版）：取回来的卡片和原来全取的完全一样，列头照原样在卡片上算
 *   - 刚新建的那张不在前 50 也带上；不在五个阶段里的老阶段照旧不出卡片、但算进「是否空」
 *   - 随机数据：同金额一大片、多币种（小写、认不得的退回人民币、没有币种行的老数据）、
 *     赢单正好在 30 天边界上、id 有大写 / 连字符
 *   - 列头 挪出 / 挪进 只取了一部分的列：等于原来在全部行上按「显示在哪列」算
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { OPP_STAGES } from "@/lib/constants";
import { 按币种合计 } from "@/lib/currency";
import { 带币种, 商机币种 } from "@/lib/money-db";
import { 取管道, 管道条件 } from "@/lib/pipeline-page";
import { 每批, 读每列, 写每列, 列头, 汇总, 读新, 加新, 记几张 } from "@/lib/pipeline-columns";

beforeEach(resetDb);

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

const 天 = 86_400_000;
const 现在 = Date.parse("2026-10-24T08:00:00Z");
const 起 = new Date(现在 - 30 * 天);

/** 每个阶段灌几张：有 0、不到一批、正好一批、多一张、好几批 */
const 每阶段 = [130, 49, 50, 51, 0];

async function 灌(种子: number, 整数金额 = false) {
  const r = 随机(种子);
  const 人 = await Promise.all(
    ["甲", "乙", "丙"].map((n, i) => prisma.user.create({ data: { email: `pipe${种子}-${i}`, name: n, role: "SALES", password: "x" } })),
  );
  const 客户 = Array.from({ length: 20 }, (_, i) => ({ id: `pc${种子}-${i}`, name: `客户${i}`, phone: `137${种子}${i}`, salesOwnerId: 人[0].id }));
  await prisma.customer.createMany({ data: 客户 });
  // 同金额一大片：金额从几个固定值里挑，再混一点随机小数
  const 金额 = () => (整数金额 ? [0, 100, 100, 2500, 99999][Math.floor(r() * 5)] : r() < 0.6 ? [0, 100, 100.5, 2500, 1e6][Math.floor(r() * 5)] : Math.round(r() * 1e7) / 100);
  const 编号 = (i: number) => [`o${种子}-${i}`, `O${种子}x${i}`, `o${种子}_${i}`, `co${种子}${i}`][i % 4];
  const 币种 = [null, "CNY", "USD", "usd ", "EUR", "XYZ"];
  let i = 0;
  const 行: { id: string; stage: string; status: string; closed: Date | null | "无"; updatedAt: Date; 币: string | null }[] = [];
  for (const [k, n] of 每阶段.entries()) {
    for (let j = 0; j < n; j++) 行.push({ id: 编号(i++), stage: OPP_STAGES[k], status: "OPEN", closed: "无", updatedAt: new Date(现在), 币: 币种[Math.floor(r() * 币种.length)] });
  }
  // 赢单：30 天边界前后、有结单时刻 / 老数据没有
  for (const 差 of [-1, 0, 1, 5 * 天, -5 * 天]) {
    行.push({ id: 编号(i++), stage: "赢单成交", status: "WON", closed: new Date(起.getTime() + 差), updatedAt: new Date(现在 - 60 * 天), 币: "USD" });
    行.push({ id: 编号(i++), stage: "赢单成交", status: "WON", closed: null, updatedAt: new Date(起.getTime() + 差), 币: null });
  }
  // 丢单、不在五个阶段里的老阶段
  行.push({ id: 编号(i++), stage: "需求确认", status: "LOST", closed: new Date(现在), updatedAt: new Date(现在), 币: null });
  行.push({ id: 编号(i++), stage: "老阶段", status: "OPEN", closed: "无", updatedAt: new Date(现在), 币: null });

  for (const o of 行) {
    await prisma.opportunity.create({
      data: {
        id: o.id,
        name: `商机${o.id}`,
        amount: 金额(),
        stage: o.stage,
        status: o.status,
        customerId: 客户[Math.floor(r() * 客户.length)].id,
        ownerId: 人[Math.floor(r() * 人.length)].id,
        updatedAt: o.updatedAt,
        ...(o.closed instanceof Date ? { closed: { create: { closedAt: o.closed } } } : {}),
        ...(o.币 ? { money: { create: { currency: o.币 } } } : {}),
      },
    });
  }
  // 赢单 30 天外的老数据靠 updatedAt：上面 create 时 @updatedAt 会被盖成现在，补一遍
  for (const o of 行.filter((x) => x.closed === null)) {
    await prisma.$executeRawUnsafe(`UPDATE Opportunity SET updatedAt = ? WHERE id = ?`, o.updatedAt.getTime(), o.id);
  }
}

/** 原来 page.tsx 那一段：全取回来、映射成卡片 */
async function 原来全取() {
  const opps = await prisma.opportunity.findMany({
    where: 管道条件(起),
    orderBy: { amount: "desc" },
    include: { customer: { select: { id: true, name: true } }, owner: { select: { name: true } }, ...带币种.商机 },
  });
  return opps.map((o) => ({
    id: o.id,
    name: o.name,
    amount: o.amount,
    currency: 商机币种(o),
    stage: o.stage,
    status: o.status,
    probability: o.probability,
    expectedDealAt: o.expectedDealAt?.toISOString() ?? null,
    customerId: o.customer.id,
    customerName: o.customer.name,
    ownerId: o.ownerId,
    ownerName: o.owner.name,
  }));
}
type 卡 = Awaited<ReturnType<typeof 原来全取>>[number];

/** 原来列头：在全部卡片上按「显示在哪列」筛、按币种合计 */
const 原来列头 = (全: 卡[], stage: string, 显示阶段: (r: 卡) => string = (r) => r.stage) => {
  const items = 全.filter((r) => 显示阶段(r) === stage);
  return { 条数: items.length, 合计: 按币种合计(items, (r) => r.amount, (r) => r.currency) };
};

/** 库里的排序：金额从大到小，同金额按 id 字节序（ASCII 下 JS 的 < 就是字节序） */
const 库序 = (a: 卡, b: 卡) => b.amount - a.amount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const 新页 = (每列: Record<string, number>, 新?: string | string[]) => 取管道(prisma, 起, 每列, 新);

describe("商机管道分批取", () => {
  for (const 种子 of [1, 2, 3]) {
    it(`列头条数 / 合计 = 全部（种子 ${种子}）`, async () => {
      await 灌(种子);
      const 全 = await 原来全取();
      const 页 = await 新页(读每列(undefined));
      expect(页.总条数).toBe(全.length);
      expect(new Set(页.负责人)).toEqual(new Set(全.map((r) => r.ownerId)));
      for (const s of OPP_STAGES) {
        const 头 = 列头(s, 页.rows, (r) => r.stage, 页.列![s]);
        const 原 = 原来列头(全, s);
        expect({ 条数: 头.条数, 合计: 头.合计 }).toEqual(原);
        const 这列取回 = 页.rows.filter((r) => r.stage === s).length;
        expect(这列取回).toBe(Math.min(原.条数, 每批));
        expect(头.还有).toBe(原.条数 - 这列取回);
      }
      // 老阶段不出卡片
      expect(页.rows.some((r) => !(OPP_STAGES as readonly string[]).includes(r.stage))).toBe(false);
    });

    it(`「再看 50 条」翻到底：每列正好是全部，顺序是库序（种子 ${种子}）`, async () => {
      await 灌(种子);
      const 全 = (await 原来全取()).sort(库序);
      let 每列 = 读每列(undefined);
      for (let 轮 = 0; 轮 < 10; 轮++) {
        const 页 = await 新页(每列);
        // 每一轮：每列取回的是全部的前 N 张，卡片内容一字不差
        for (const s of OPP_STAGES) {
          const 这列全 = 全.filter((r) => r.stage === s);
          expect(页.rows.filter((r) => r.stage === s)).toEqual(这列全.slice(0, 每列[s]));
        }
        const 还有 = OPP_STAGES.filter((s) => 列头(s, 页.rows, (r) => r.stage, 页.列?.[s]).还有 > 0);
        if (!还有.length) break;
        // 和页面上的按钮一样：点了的那列加一批（URL 走一遍 写每列 / 读每列）
        每列 = 读每列(写每列({ ...每列, [还有[0]]: 每列[还有[0]] + 每批 }));
      }
      // 翻到底：全都要摆了，照原来整取（老阶段也在，页面自己不摆），只是顺序带上 id、和翻页时一致
      const 页 = await 新页(每列);
      expect(页.rows).toEqual(全);
      expect(页.列).toBeUndefined();
      for (const s of OPP_STAGES) expect(列头(s, 页.rows, (r) => r.stage, 页.列?.[s]).还有).toBe(0);
    });
  }

  it("每列不到 50 张（个人版）：卡片和原来全取的一样，列头在卡片上算", async () => {
    await 灌(7);
    // 删到每列都不到一批
    for (const s of OPP_STAGES) {
      const 多 = await prisma.opportunity.findMany({ where: { stage: s, ...管道条件(起) }, orderBy: { id: "asc" }, skip: 40, select: { id: true } });
      await prisma.opportunity.deleteMany({ where: { id: { in: 多.map((x) => x.id) } } });
    }
    const 全 = await 原来全取();
    // 记下取数时发给库的参数：全取时必须是原来那一句（同样的 where / orderBy / include），不加 id 排序
    const 发: Prisma.OpportunityFindManyArgs[] = [];
    const 记库 = { opportunity: { findMany: (a: Prisma.OpportunityFindManyArgs) => (发.push(a), prisma.opportunity.findMany(a)) } } as unknown as Parameters<typeof 取管道>[0];
    const 页 = await 取管道(记库, 起, 读每列(undefined));
    // 和原来一字不差：同样的行、同样的顺序（老阶段也在，页面自己不摆），不带列汇总 / 总条数 / 负责人
    expect(页).toEqual({ rows: 全 });
    const 整取 = 发[发.length - 1];
    expect(整取.orderBy).toEqual({ amount: "desc" });
    expect(整取.where).toEqual(管道条件(起));
    for (const s of OPP_STAGES) expect(列头(s, 页.rows, (r) => r.stage, undefined)).toEqual({ ...原来列头(全, s), 还有: 0 });
  });

  it("没有商机：空", async () => {
    const 页 = await 新页(读每列(undefined));
    expect(页).toEqual({ rows: [] });
  });

  it("刚新建的那张不在前 50 也带上；老阶段、不存在的、不在管道里的不带", async () => {
    await 灌(4);
    const 全 = (await 原来全取()).sort(库序);
    const 第一列 = 全.filter((r) => r.stage === OPP_STAGES[0]);
    const 末张 = 第一列[第一列.length - 1];
    const 页 = await 新页(读每列(undefined), 末张.id);
    expect(页.rows.filter((r) => r.stage === OPP_STAGES[0])).toEqual([...第一列.slice(0, 每批), 末张]);
    // 带上了也不改列头：还有 = 全部 − 这列取回的
    expect(列头(OPP_STAGES[0], 页.rows, (r) => r.stage, 页.列![OPP_STAGES[0]]).还有).toBe(第一列.length - 每批 - 1);

    const 老 = 全.find((r) => r.stage === "老阶段")!;
    const 丢 = await prisma.opportunity.findFirst({ where: { status: "LOST" } });
    const 基线 = await 新页(读每列(undefined));
    for (const 新 of [老.id, 丢!.id, "不存在", 第一列[0].id]) expect((await 新页(读每列(undefined), 新)).rows).toEqual(基线.rows);
  });

  it("刚挪过的几张（new=a,b）都带上，各在各的列；重复的、不在管道里的不重复带", async () => {
    await 灌(4);
    const 全 = (await 原来全取()).sort(库序);
    const 第一列 = 全.filter((r) => r.stage === OPP_STAGES[0]);
    const [甲, 乙] = [第一列[第一列.length - 1], 第一列[第一列.length - 2]];
    const 期望 = [...第一列.slice(0, 每批), 乙, 甲];
    for (const 新 of [`${甲.id},${乙.id}`, [甲.id, 乙.id], `${甲.id},不存在,${乙.id},${甲.id},${第一列[0].id}`]) {
      expect((await 新页(读每列(undefined), 新)).rows.filter((r) => r.stage === OPP_STAGES[0])).toEqual(期望);
    }
  });

  it("列头：挪出 / 挪进只取了一部分的列 = 原来在全部行上按显示阶段算", async () => {
    await 灌(5, true);
    const 全 = await 原来全取();
    const 页 = await 新页(读每列(undefined));
    const [大, 小, 正好, 多一] = OPP_STAGES;
    // 从大列（取了一部分）挪到小列（全取回来了）、从多一张的列挪到大列、挪到没有卡的赢单列
    const 挪法 = [
      { id: 页.rows.find((r) => r.stage === 大)!.id, 到: 小 },
      { id: 页.rows.find((r) => r.stage === 多一)!.id, 到: 大 },
      { id: 页.rows.find((r) => r.stage === 正好)!.id, 到: "赢单成交" },
      { id: 页.rows.find((r) => r.stage === 大 && r.currency === "USD")!.id, 到: 多一 },
    ];
    for (const 挪 of 挪法) {
      const 显示阶段 = (r: 卡) => (r.id === 挪.id ? 挪.到 : r.stage);
      for (const s of OPP_STAGES) {
        const 头 = 列头(s, 页.rows, 显示阶段, 页.列![s]);
        expect({ 条数: 头.条数, 合计: 头.合计 }).toEqual(原来列头(全, s, 显示阶段));
      }
    }
  });

  it("挪走一列里某个币种的最后一张：列头去掉这个币种", () => {
    const 卡 = (id: string, stage: string, amount: number, currency: string) => ({ id, stage, amount, currency });
    const 全 = [卡("a", "初步沟通", 300, "CNY"), 卡("b", "初步沟通", 200, "USD"), 卡("c", "初步沟通", 100, "CNY")];
    const 汇 = 汇总(全, (r) => r.amount, (r) => r.currency);
    const 已载 = 全.slice(0, 2);
    const 头 = 列头("初步沟通", 已载, (r) => (r.id === "b" ? "需求确认" : r.stage), 汇);
    expect(头).toEqual({ 条数: 2, 合计: [{ 币种: "CNY", 合计: 400 }], 还有: 1 });
  });
});

describe("每列张数在 URL 里", () => {
  it("缺的、不合法的、小于一批的都按一批；按阶段顺序写回", () => {
    const 一批 = Object.fromEntries(OPP_STAGES.map((s) => [s, 每批]));
    expect(读每列(undefined)).toEqual(一批);
    expect(读每列("")).toEqual(一批);
    expect(读每列("abc,-1,0,49.5,1e400")).toEqual(一批);
    expect(读每列("100,,150")).toEqual({ ...一批, [OPP_STAGES[0]]: 100, [OPP_STAGES[2]]: 150 });
    expect(写每列(读每列("100,50,150,50,200,999"))).toBe("100,50,150,50,200");
    expect(写每列({})).toBe(OPP_STAGES.map(() => 每批).join(","));
  });
});

describe("刚挪过的几张在 URL 里（new=）", () => {
  it("逗号分开、去重、去空；只留最近的 记几张 张", () => {
    expect(读新(undefined)).toEqual([]);
    expect(读新("")).toEqual([]);
    expect(读新(" a, ,b,a,c ")).toEqual(["a", "b", "c"]);
    const 多 = Array.from({ length: 记几张 + 5 }, (_, i) => `x${i}`);
    expect(读新(多.join(","))).toEqual(多.slice(5));
  });
  it("加新：加在最后，已有的挪到最后，超了截掉最早的", () => {
    expect(加新(null, "a")).toBe("a");
    expect(加新("a,b", "c")).toBe("a,b,c");
    expect(加新("a,b,c", "a")).toBe("b,c,a");
    const 满 = Array.from({ length: 记几张 }, (_, i) => `x${i}`).join(",");
    expect(加新(满, "y").split(",")).toEqual([...读新(满).slice(1), "y"]);
  });
});
