/**
 * 看板趋势改成「每行只建一次 dayjs」之后，和原来「天数 × 行数」的写法对拍（2026-10-20）。
 *
 * 下面的 旧趋势 / 旧8周 / 旧每周新增 是 dashboard/Board.tsx 原来那几段，一字没改搬过来当基准。
 * 两边吃同一批数据，输出必须完全一样：
 *   - 随机数据：每个「现在」100 个客户 + 200 条跟进（三成落在边界时刻上），再加一批 2000 客户，散在「现在」前后 200 天
 *   - 边界：正好零点、零点前 1 毫秒、零点后 1 毫秒；跨月、跨年；30 天窗口的两头；现在这一刻
 *   - 时区：Asia/Shanghai（生产）、Europe/London 和 America/New_York（有夏令时）；
 *     托管版的北京业务钟（MULTI_TENANT=1）和桌面端的本机时钟各一遍
 *   - 空数据
 */
import { describe, it, expect, afterAll } from "vitest";
import { dayjs } from "@/lib/utils";
import { 近90天趋势, 最近8周, 每周新增 } from "@/lib/dashboard-trend";
import type { Dayjs } from "dayjs";

type 客户 = { createdAt: Date };
type 跟进 = { customerId: string; occurredAt: Date };

function 旧趋势(now: Dayjs, customersForTrend: 客户[], followDates: 跟进[]) {
  const days = Array.from({ length: 90 }, (_, i) => now.subtract(89 - i, "day"));
  return days.map((d) => {
    const total = customersForTrend.filter((c) => !dayjs(c.createdAt).isAfter(d, "day")).length;
    const activeIds = new Set(
      followDates
        .filter(
          (f) =>
            !dayjs(f.occurredAt).isAfter(d, "day") &&
            dayjs(f.occurredAt).isAfter(d.subtract(30, "day"), "day"),
        )
        .map((f) => f.customerId),
    );
    return { label: d.format("MM-DD"), created: total, active: activeIds.size };
  });
}

function 旧8周(now: Dayjs) {
  return Array.from({ length: 8 }, (_, i) => ({
    起: now.subtract(7 - i, "week").startOf("week"),
    止: now.subtract(6 - i, "week").startOf("week"),
  }));
}

function 旧每周新增(周: { 起: Dayjs; 止: Dayjs }[], customersForTrend: 客户[]) {
  return 周.map(
    (w) => customersForTrend.filter((c) => dayjs(c.createdAt).isAfter(w.起) && dayjs(c.createdAt).isBefore(w.止)).length,
  );
}

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

const 天 = 86_400_000;

/** 「现在」附近的一批边界时刻：每天零点前后各 1 毫秒、正好零点，和现在这一刻 */
function 边界时刻(now: Dayjs): Date[] {
  const out: Date[] = [now.toDate(), new Date(now.valueOf() - 1), new Date(now.valueOf() + 1)];
  for (let i = -125; i <= 3; i++) {
    const 零点 = now.add(i, "day").startOf("day").valueOf();
    out.push(new Date(零点), new Date(零点 - 1), new Date(零点 + 1));
  }
  for (const 月 of [-4, -3, -2, -1, 0, 1]) {
    const 月初 = now.add(月, "month").startOf("month").valueOf();
    out.push(new Date(月初), new Date(月初 - 1));
  }
  return out;
}

function 造数据(now: Dayjs, 种子: number, 个数: number) {
  const r = 随机(种子);
  const 时刻 = () => new Date(now.valueOf() + Math.floor((r() * 2 - 1.6) * 200 * 天));
  const 边界 = 边界时刻(now);
  const 客户: 客户[] = [];
  const 跟进: 跟进[] = [];
  for (let i = 0; i < 个数; i++) 客户.push({ createdAt: r() < 0.3 ? 边界[Math.floor(r() * 边界.length)] : 时刻() });
  for (let i = 0; i < 个数 * 2; i++) {
    跟进.push({
      // 同一个客户多条跟进：活跃数是去重后的人数
      customerId: `c${Math.floor(r() * 个数 * 0.6)}`,
      occurredAt: r() < 0.3 ? 边界[Math.floor(r() * 边界.length)] : 时刻(),
    });
  }
  return { 客户, 跟进 };
}

/** 跨月、跨年、夏令时切换那几天，各挑一个「现在」 */
const 现在们 = [
  "2026-10-20T03:15:00Z",
  "2026-12-31T15:59:59.999Z", // 北京 1 月 1 日零点前 1 毫秒
  "2026-12-31T16:00:00.000Z", // 北京 1 月 1 日零点
  "2027-01-01T00:30:00Z",
  "2026-03-01T00:00:00Z",
  "2026-02-28T23:59:59Z",
  "2026-03-29T01:30:00Z", // 伦敦进夏令时
  "2026-10-25T00:30:00Z", // 伦敦出夏令时
  "2026-03-08T07:30:00Z", // 纽约进夏令时
  "2026-11-01T06:30:00Z", // 纽约出夏令时
];
const 时区们 = ["Asia/Shanghai", "Europe/London", "America/New_York"];
const 时钟们 = [
  { 名: "本机时钟（桌面端）", MULTI_TENANT: undefined },
  { 名: "北京业务钟（托管版）", MULTI_TENANT: "1" },
];

const 原TZ = process.env.TZ;
const 原MT = process.env.MULTI_TENANT;
function 设环境(tz: string, mt: string | undefined) {
  process.env.TZ = tz;
  if (mt === undefined) delete process.env.MULTI_TENANT;
  else process.env.MULTI_TENANT = mt;
}
afterAll(() => {
  process.env.TZ = 原TZ;
  if (原MT === undefined) delete process.env.MULTI_TENANT;
  else process.env.MULTI_TENANT = 原MT;
});

describe("看板趋势：新写法和原来的写法输出一模一样", () => {
  for (const tz of 时区们) {
    for (const 钟 of 时钟们) {
      it(`${tz} · ${钟.名}`, () => {
        设环境(tz, 钟.MULTI_TENANT);
        // 时区真的换上了：不然后面三遍测的其实是同一个时区
        expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(tz);
        现在们.forEach((iso, k) => {
          const now = dayjs(new Date(iso));
          const { 客户, 跟进 } = 造数据(now, 1000 + k, 100);
          expect(近90天趋势(now, 客户, 跟进), `近 90 天 · 现在=${iso}`).toEqual(旧趋势(now, 客户, 跟进));
          const 周 = 最近8周(now);
          expect(周.map((w) => [w.起.valueOf(), w.止.valueOf()]), `8 周 · 现在=${iso}`).toEqual(
            旧8周(now).map((w) => [w.起.valueOf(), w.止.valueOf()]),
          );
          expect(每周新增(周, 客户), `每周新增 · 现在=${iso}`).toEqual(旧每周新增(旧8周(now), 客户));
        });
      }, 60_000);
    }
  }

  it("空数据：90 个点都是 0，8 周都是 0", () => {
    设环境("Asia/Shanghai", undefined);
    const now = dayjs(new Date("2026-10-20T03:15:00Z"));
    const 新 = 近90天趋势(now, [], []);
    expect(新).toEqual(旧趋势(now, [], []));
    expect(新).toHaveLength(90);
    expect(新.every((p) => p.created === 0 && p.active === 0)).toBe(true);
    expect(新.at(-1)?.label).toBe("10-20");
    expect(每周新增(最近8周(now), [])).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("大一点的随机量（2000 客户 / 4000 条跟进）也一致", () => {
    设环境("Asia/Shanghai", undefined);
    const now = dayjs(new Date("2026-10-20T03:15:00Z"));
    const { 客户, 跟进 } = 造数据(now, 42, 2000);
    expect(近90天趋势(now, 客户, 跟进)).toEqual(旧趋势(now, 客户, 跟进));
    expect(每周新增(最近8周(now), 客户)).toEqual(旧每周新增(旧8周(now), 客户));
  });
});
