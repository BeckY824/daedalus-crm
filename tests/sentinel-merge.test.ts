/**
 * 盯盘名单：别的几样（逾期计划、订单节点、停滞商机）判好的清单和沉睡的前几名归并（lib/sentinel-data.ts 的 合并，2026-10-25），
 * 必须和 buildWatchlist 把全部原料一起判、再切前 n 条一模一样。
 *
 *   - 纯函数随机对拍：同一客户多条计划 / 商机 / 订单 + 沉睡，商机和沉睡同分（buildWatchlist 留先放进去的沉睡），
 *     客户 id 有大写、连字符、下划线；沉睡给全量和只给前 n 名两种；n 从 1 到全部
 *   - 给出去的是拷贝：改返回值不动别的那份（缓存里共用的）
 *   - 库里对拍：有逾期计划、停滞商机、沉睡客户，loadWatchlistPage 一页页翻、跳页、越界页都和全量判的一样
 */
import { describe, it, expect, afterAll } from "vitest";
import type { Dayjs } from "dayjs";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { dayjs } from "@/lib/utils";
import { buildWatchlist, STATUS_WEIGHT, type SentinelInput, type WatchItem } from "@/lib/sentinel";
import { loadWatchlistPage, _内部 } from "@/lib/sentinel-data";
import { 逾期条件 } from "@/lib/overdue";
import { scheduleValue } from "@/lib/schedule-date";
import { getBusiness } from "@/lib/business";
import { statusLabel, stageLabel } from "@/lib/business-config";

const 原TZ = process.env.TZ;
afterAll(() => {
  process.env.TZ = 原TZ;
});

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
const 编号 = (i: number) => [`perf-c${i}`, `PF-${i}`, `pfc${i}`, `Pf_${i}`][i % 4];
const 判 = (input: SentinelInput, now: Date) => buildWatchlist(input, now, "学员", (v) => v, Infinity);

function 造(种子: number, now: Date): SentinelInput {
  const r = 随机(种子);
  const 池 = 20 + Math.floor(r() * 60);
  const 挑客户 = () => Math.floor(r() * 池);
  const 几天前 = (lo: number, hi: number) => new Date(now.valueOf() - (lo + Math.floor(r() * (hi - lo + 1))) * 天);
  const 状态们 = [...Object.keys(STATUS_WEIGHT), "已签约"];
  const customers: SentinelInput["customers"] = [];
  for (let i = 0; i < 池; i++) {
    if (r() < 0.3) continue;
    customers.push({ id: 编号(i), name: `客户${i}`, followStatus: 状态们[Math.floor(r() * 状态们.length)], lastFollowAt: r() < 0.1 ? null : 几天前(5, 70), createdAt: 几天前(60, 90), ownerName: "甲" });
  }
  const overduePlans = Array.from({ length: Math.floor(r() * 池 * 0.4) }, (_, k) => {
    const i = 挑客户();
    return { customerId: 编号(i), customerName: `客户${i}`, ownerName: "甲", subject: `计划${k}`, plannedAt: 几天前(-3, 40) };
  });
  const opportunities = Array.from({ length: Math.floor(r() * 池 * 0.8) }, (_, k) => {
    const i = 挑客户();
    return { customerId: 编号(i), customerName: `客户${i}`, ownerName: "乙", name: `商机${k}`, stage: "初步沟通", updatedAt: 几天前(5, 70) };
  });
  const lateOrderNodes = Array.from({ length: Math.floor(r() * 池 * 0.2) }, (_, k) => {
    const i = 挑客户();
    return { orderId: `o${k}`, orderNo: `NO${k}`, idx: 1 + (k % 5), nodeName: "订舱", dueAt: r() < 0.2 ? null : 几天前(-5, 40), 卡住: r() < 0.3, customerId: 编号(i), customerName: `客户${i}`, ownerName: "丙" };
  });
  return { overduePlans, customers, opportunities, lateOrderNodes };
}

describe("合并：和 buildWatchlist 一起判、切前 n 条一样", () => {
  it("随机 400 组", () => {
    const now = new Date("2026-10-25T03:15:00Z");
    const 见过 = { 同分留沉睡: 0, 商机胜沉睡: 0, 计划胜沉睡: 0, 只沉睡: 0 };
    for (let 种子 = 1; 种子 <= 400; 种子++) {
      const input = 造(种子, now);
      const 全 = 判(input, now);
      const 清单 = 判({ ...input, customers: [] }, now);
      const 按客户 = new Map(清单.map((x) => [x.customerId, x]));
      const 沉睡 = 判({ overduePlans: [], opportunities: [], lateOrderNodes: [], customers: input.customers }, now);
      for (const s of 沉睡) {
        const o = 按客户.get(s.customerId);
        if (!o) 见过.只沉睡++;
        else if (o.kind === "stalled_opp" && o.score === s.score) 见过.同分留沉睡++;
        else if (o.kind === "stalled_opp" && o.score > s.score) 见过.商机胜沉睡++;
        else if (o.kind !== "stalled_opp") 见过.计划胜沉睡++;
      }
      const 原样 = JSON.stringify(清单);
      for (const n of [1, 2, 3, 5, 8, 13, 16, 40, 1000]) {
        // 库里只给沉睡前 n 名（loadWatchlistPage 的取法），也给全量
        for (const 给的 of [沉睡.slice(0, n), 沉睡]) {
          const 出 = _内部.合并({ 清单, 按客户 }, 给的, n);
          expect(出, `种子 ${种子} · n=${n} · 沉睡给 ${给的.length}`).toEqual(全.slice(0, n));
          // 改返回值不动别的那份
          for (const x of 出) {
            x.score = -1;
            x.reason = "改了";
          }
        }
      }
      expect(JSON.stringify(清单), `种子 ${种子} · 别的那份没被改`).toBe(原样);
    }
    // 几种情形都真碰到了才算测到
    for (const [k, v] of Object.entries(见过)) expect(v, k).toBeGreaterThan(0);
  });

  it("沉睡和商机同分：留沉睡、商机让掉，不重复出这个客户", () => {
    const now = new Date("2026-10-25T03:15:00Z");
    // 待跟进权重 1：8 + 天数 30 = 38 → 改成 已加微信 3：24 + 30 = 54；商机 50 + (18 - 14) = 54
    const input: SentinelInput = {
      overduePlans: [],
      customers: [{ id: "PF-1", name: "甲", followStatus: "已加微信", lastFollowAt: new Date(now.valueOf() - 30 * 天), createdAt: new Date(now.valueOf() - 90 * 天), ownerName: "甲" }],
      opportunities: [
        { customerId: "PF-1", customerName: "甲", ownerName: "乙", name: "同分", stage: "初步沟通", updatedAt: new Date(now.valueOf() - 18 * 天) },
        { customerId: "perf-c2", customerName: "乙", ownerName: "乙", name: "另一个", stage: "初步沟通", updatedAt: new Date(now.valueOf() - 18 * 天) },
      ],
    };
    const 全 = 判(input, now);
    expect(全.map((x) => [x.customerId, x.kind, x.score])).toEqual([["perf-c2", "stalled_opp", 54], ["PF-1", "sleeping", 54]]);
    const 清单 = 判({ ...input, customers: [] }, now);
    const 沉睡 = 判({ ...input, opportunities: [] }, now);
    expect(_内部.合并({ 清单, 按客户: new Map(清单.map((x) => [x.customerId, x])) }, 沉睡, 8)).toEqual(全);
  });
});

/** 全量判：逾期计划、商机、沉睡客户全取回来交给 buildWatchlist（订单节点这一版不上） */
async function 原来(now: Dayjs) {
  const [plans, customers, opps, business] = await Promise.all([
    prisma.followPlan.findMany({
      where: 逾期条件({}, now.toDate()).plan,
      select: { subject: true, plannedAt: true, plannedOn: true, customer: { select: { id: true, name: true } }, owner: { select: { name: true } } },
    }),
    prisma.customer.findMany({
      where: { followStatus: { notIn: ["已签约", "已流失", "暂缓跟进"] } },
      select: { id: true, name: true, followStatus: true, lastFollowAt: true, createdAt: true, salesOwner: { select: { name: true } } },
    }),
    prisma.opportunity.findMany({
      where: { status: "OPEN" },
      select: { name: true, stage: true, updatedAt: true, activityAt: true, customer: { select: { id: true, name: true } }, owner: { select: { name: true } } },
    }),
    getBusiness(),
  ]);
  return buildWatchlist(
    {
      overduePlans: plans.map((p) => ({ customerId: p.customer.id, customerName: p.customer.name, ownerName: p.owner.name, subject: p.subject, plannedAt: scheduleValue(p.plannedAt, p.plannedOn)! })),
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

async function 灌(now: Dayjs, 种子: number) {
  const r = 随机(种子);
  const 前 = (lo: number, hi: number) => new Date(now.valueOf() - (lo + r() * (hi - lo)) * 天);
  const 人们: string[] = [];
  for (const k of [0, 1]) 人们.push((await prisma.user.create({ data: { email: `sm${种子}-${k}`, name: `销售${k}`, role: "SALES", password: "x" } })).id);
  const 状态们 = [...Object.keys(STATUS_WEIGHT), "已签约", "暂缓跟进"];
  const 客户 = Array.from({ length: 160 }, (_, i) => ({
    id: 编号(i), name: `客户${i}`, phone: `135${种子}${i}`, salesOwnerId: 人们[i % 2],
    followStatus: 状态们[Math.floor(r() * 状态们.length)], createdAt: 前(50, 90), lastFollowAt: r() < 0.1 ? null : 前(1, 60),
  }));
  await prisma.customer.createMany({ data: 客户 });
  await prisma.opportunity.createMany({
    data: Array.from({ length: 100 }, (_, i) => ({ name: `商机${i}`, customerId: 客户[Math.floor(r() * 160)].id, ownerId: 人们[(i + 1) % 2], status: r() < 0.85 ? "OPEN" : "WON", updatedAt: 前(5, 70), activityAt: r() < 0.3 ? null : 前(5, 70) })),
  });
  await prisma.followPlan.createMany({
    data: Array.from({ length: 70 }, (_, i) => ({ subject: `计划${i}`, customerId: 客户[Math.floor(r() * 160)].id, ownerId: 人们[i % 2], plannedAt: 前(-3, 35), done: r() < 0.2 })),
  });
}

describe("库里对拍：有逾期计划、停滞商机、沉睡客户", () => {
  for (const tz of ["Asia/Shanghai", "Europe/London"]) {
    it(tz, async () => {
      process.env.TZ = tz;
      for (const [k, iso] of ["2026-10-25T03:15:00Z", "2026-10-25T00:30:00Z", "2026-12-31T16:00:00.000Z"].entries()) {
        await resetDb();
        const now = dayjs(new Date(iso));
        await 灌(now, 500 + k);
        expect(_内部.沉睡边界(now), `走库里取前几名 · ${iso}`).not.toBeNull();
        const 基准 = await 原来(now);
        for (const kind of ["overdue_plan", "sleeping", "stalled_opp"]) expect(基准.some((x) => x.kind === kind), `有 ${kind} · ${iso}`).toBe(true);
        const 末页 = Math.max(0, Math.floor((基准.length - 1) / 8) * 8);
        for (const off of [0, 8, 13, 24, 末页, 末页 + 8, 基准.length + 50]) {
          const 页 = await loadWatchlistPage(now, {}, off, 8);
          const 起 = Math.min(off, 末页);
          expect(页.total, `总数 · ${iso} · off=${off}`).toBe(基准.length);
          expect(页.items, `第 ${off} 条起 · ${iso}`).toEqual(基准.slice(起, 起 + 8));
        }
        const 全: WatchItem[] = [];
        for (let off = 0; off < 基准.length; off += 100) 全.push(...(await loadWatchlistPage(now, {}, off, 100)).items);
        expect(全, `一页 100 条翻完 · ${iso}`).toEqual(基准);
      }
    }, 60_000);
  }
});

