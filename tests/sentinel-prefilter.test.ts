/**
 * 盯盘名单在库里先粗筛沉睡客户、停滞商机（lib/sentinel-data.ts，2026-10-24 企业版压测），
 * 和原来「全取回来交给 buildWatchlist 判」对拍：名单、顺序、总数必须完全一样。
 *
 *   - 随机数据：客户各种状态（含终态、暂缓、没权重的），最近跟进有空、有未来（录错）、有过去；商机开着 / 关了，activityAt 有空
 *   - 三成时刻落在边界上：离现在 11–15 个 24 小时前后 1 毫秒、每天零点前后 1 毫秒、现在这一刻
 *   - 时区：Asia/Shanghai、Europe/London、America/New_York（夏令时那几天）
 *   - 按人看（业务员）和看全部各一遍
 *   - 沉睡客户库里只取前几名（不限定时）：断言真走了这条路；每页 8 条从头翻、跳页、越界页都和全量切出来的一样；
 *     客户 id 有大写 / 连字符时（库里按字节排和 localeCompare 不一样）同分照样按 localeCompare 排；同分的一大片也对
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { Dayjs } from "dayjs";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { dayjs } from "@/lib/utils";
import { buildWatchlist } from "@/lib/sentinel";
import { loadWatchlistPage, _内部 } from "@/lib/sentinel-data";
import { getBusiness } from "@/lib/business";
import { statusLabel, stageLabel } from "@/lib/business-config";

const 原TZ = process.env.TZ;
afterAll(() => {
  process.env.TZ = 原TZ;
});
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
const 状态们 = ["意向较高", "已试听", "已加微信", "跟进中", "待跟进", "已签约", "已流失", "暂缓跟进", "随便写的"];

function 边界时刻(now: Dayjs): Date[] {
  const out: Date[] = [now.toDate(), new Date(now.valueOf() - 1), new Date(now.valueOf() + 1)];
  for (let i = 11; i <= 15; i++) for (const d of [-1, 0, 1]) out.push(new Date(now.valueOf() - i * 天 + d));
  for (let i = -16; i <= 2; i++) {
    const 零点 = now.add(i, "day").startOf("day").valueOf();
    out.push(new Date(零点), new Date(零点 - 1), new Date(零点 + 1));
  }
  return out;
}

async function 灌(now: Dayjs, 种子: number, 编号 = (i: number) => `pf${种子}c${i}`) {
  const r = 随机(种子);
  const 边界 = 边界时刻(now);
  const 挑 = () => (r() < 0.3 ? 边界[Math.floor(r() * 边界.length)] : new Date(now.valueOf() + Math.floor((r() * 2 - 1.7) * 40 * 天)));
  const 人们: string[] = [];
  for (const k of [0, 1]) 人们.push((await prisma.user.create({ data: { email: `pf${种子}-${k}`, name: `销售${k}`, role: "SALES", password: "x" } })).id);
  const 客户 = Array.from({ length: 200 }, (_, i) => {
    const 跟 = r();
    return {
      id: 编号(i),
      name: `客户${i}`,
      phone: `138${种子}${i}`,
      salesOwnerId: 人们[i % 2],
      followStatus: 状态们[Math.floor(r() * 状态们.length)],
      createdAt: 挑(),
      // 一成没跟进过，其余随机（含未来）
      lastFollowAt: 跟 < 0.1 ? null : 挑(),
    };
  });
  await prisma.customer.createMany({ data: 客户 });
  await prisma.opportunity.createMany({
    data: Array.from({ length: 120 }, (_, i) => ({
      name: `商机${i}`,
      customerId: 客户[i].id,
      ownerId: 人们[(i + 1) % 2],
      status: r() < 0.8 ? "OPEN" : r() < 0.5 ? "WON" : "LOST",
      updatedAt: 挑(),
      activityAt: r() < 0.3 ? null : 挑(),
    })),
  });
  return 人们;
}

/** 原来的取法：不粗筛，全取回来交给 buildWatchlist */
async function 原来(now: Dayjs, 谁的?: string) {
  const [customers, opps, business] = await Promise.all([
    prisma.customer.findMany({
      where: { followStatus: { notIn: ["已签约", "已流失", "暂缓跟进"] }, ...(谁的 ? { salesOwnerId: 谁的 } : {}) },
      select: { id: true, name: true, followStatus: true, lastFollowAt: true, createdAt: true, salesOwner: { select: { name: true } } },
    }),
    prisma.opportunity.findMany({
      where: { status: "OPEN", ...(谁的 ? { ownerId: 谁的 } : {}) },
      select: { name: true, stage: true, updatedAt: true, activityAt: true, customer: { select: { id: true, name: true } }, owner: { select: { name: true } } },
    }),
    getBusiness(),
  ]);
  return buildWatchlist(
    {
      overduePlans: [],
      customers: customers.map((c) => ({ id: c.id, name: c.name, followStatus: c.followStatus, lastFollowAt: c.lastFollowAt, createdAt: c.createdAt, ownerName: c.salesOwner.name })),
      opportunities: opps.map((o) => ({ customerId: o.customer.id, customerName: o.customer.name, ownerName: o.owner.name, name: o.name, stage: stageLabel(business, o.stage), updatedAt: o.activityAt ?? o.updatedAt })),
      lateOrderNodes: [],
    },
    now.toDate(),
    business.customer,
    (v) => statusLabel(business, v),
    Infinity,
  );
}

/** 现在的入口，一页页翻完 */
async function 现在的(now: Dayjs, 谁的?: string) {
  const 全 = [];
  for (let off = 0; ; off += 100) {
    const 页 = await loadWatchlistPage(now, 谁的 ? { ownerId: 谁的 } : {}, off, 100);
    全.push(...页.items);
    if (off + 100 >= 页.total) return { 全, total: 页.total };
  }
}

const 现在们 = [
  "2026-10-20T03:15:00Z",
  "2026-12-31T16:00:00.000Z",
  "2026-03-29T01:30:00Z", // 伦敦进夏令时
  "2026-04-10T12:00:00Z", // 伦敦进夏令时后 12 天：窗口跨过那一天
  "2026-10-25T00:30:00Z", // 伦敦出夏令时
  "2026-11-08T23:59:59.999Z",
  "2026-03-20T06:30:00Z", // 纽约进夏令时后 12 天
];

describe("盯盘粗筛：和全取回来判一模一样", () => {
  for (const tz of ["Asia/Shanghai", "Europe/London", "America/New_York"]) {
    it(tz, async () => {
      process.env.TZ = tz;
      expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(tz);
      for (const [k, iso] of 现在们.entries()) {
        await resetDb();
        const now = dayjs(new Date(iso));
        const 人们 = await 灌(now, 300 + k);
        // 这些「现在」都该走库里取前几名：不然对拍的是老路对老路
        const 边界 = _内部.沉睡边界(now);
        expect(边界, `边界排得出 · ${iso}`).not.toBeNull();
        expect(await _内部.沉睡前几名({ now, 边界: 边界!, 前几名: 8, 别的客户: [] }), `走库里 · ${iso}`).not.toBeNull();
        for (const 谁的 of [undefined, 人们[0]]) {
          const 基准 = await 原来(now, 谁的);
          // 粗筛真的筛到了东西才算测到：基准里得有沉睡和停滞的
          expect(基准.some((x) => x.kind === "sleeping") && 基准.some((x) => x.kind === "stalled_opp"), `有料 · ${iso}`).toBe(true);
          const 新 = await 现在的(now, 谁的);
          expect(新.total, `总数 · ${iso} · ${谁的 ?? "全部"}`).toBe(基准.length);
          expect(新.全, `名单 · ${iso} · ${谁的 ?? "全部"}`).toEqual(基准);
          await 翻页对拍(now, 谁的, 基准, `${iso} · ${谁的 ?? "全部"}`);
        }
      }
    }, 60_000);
  }
});

/** 首页那种每页 8 条：各个起点切出来的都要和全量一样，越界的落到最后一页 */
async function 翻页对拍(now: Dayjs, 谁的: string | undefined, 基准: Awaited<ReturnType<typeof 原来>>, 名: string) {
  const 末页 = Math.max(0, Math.floor((基准.length - 1) / 8) * 8);
  for (const off of [0, 8, 13, 末页, 末页 + 8, 基准.length + 50]) {
    const 页 = await loadWatchlistPage(now, 谁的 ? { ownerId: 谁的 } : {}, off, 8);
    const 起 = Math.min(off, 末页);
    expect(页.total, `总数 · ${名} · off=${off}`).toBe(基准.length);
    expect(页.offset, `起点 · ${名} · off=${off}`).toBe(起);
    expect(页.items, `第 ${off} 条起 · ${名}`).toEqual(基准.slice(起, 起 + 8));
  }
}

describe("客户 id 有大写或连字符：同分照样按 localeCompare 排", () => {
  it("Asia/Shanghai", async () => {
    process.env.TZ = "Asia/Shanghai";
    await resetDb();
    const now = dayjs(new Date("2026-10-20T03:15:00Z"));
    // 压测库就是 perf-c0、perf-c1…：字节序里 '-' 在字母前，localeCompare 不一样
    const 编号 = (i: number) => (i % 3 === 0 ? `PF-${i}` : i % 3 === 1 ? `perf-c${i}` : `pf900c${i}`);
    const 人们 = await 灌(now, 900, 编号);
    const 边界 = _内部.沉睡边界(now)!;
    expect(await _内部.沉睡前几名({ now, 边界, 前几名: 8, 别的客户: [] }), "走库里").not.toBeNull();
    for (const 谁的 of [undefined, 人们[0]]) {
      const 基准 = await 原来(now, 谁的);
      expect(基准.some((x) => x.customerId.startsWith("PF-") && x.kind === "sleeping")).toBe(true);
      const 新 = await 现在的(now, 谁的);
      expect(新.total).toBe(基准.length);
      expect(新.全).toEqual(基准);
      await 翻页对拍(now, 谁的, 基准, `大写 · ${谁的 ?? "全部"}`);
    }
  }, 60_000);

  it("同分一大片（都睡了 40 天以上、同一状态）", async () => {
    process.env.TZ = "Asia/Shanghai";
    await resetDb();
    const now = dayjs(new Date("2026-10-20T03:15:00Z"));
    const 人 = (await prisma.user.create({ data: { email: "pf-tie", name: "销售", role: "SALES", password: "x" } })).id;
    const 久 = new Date(now.valueOf() - 60 * 天);
    await prisma.customer.createMany({
      data: Array.from({ length: 150 }, (_, i) => ({
        id: [`perf-c${i}`, `PF-${i}`, `pfc${i}`, `Pf_${i}`][i % 4],
        name: `客户${i}`,
        phone: `137${i}`,
        salesOwnerId: 人,
        followStatus: i % 10 === 0 ? "已试听" : "意向较高",
        createdAt: 久,
        lastFollowAt: 久,
      })),
    });
    const 基准 = await 原来(now);
    expect(new Set(基准.map((x) => x.score)).size).toBe(2);
    const 新 = await 现在的(now);
    expect(新.total).toBe(基准.length);
    expect(新.全).toEqual(基准);
    await 翻页对拍(now, undefined, 基准, "同分");
  }, 60_000);
});
