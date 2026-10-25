/**
 * 首页看板另两条小曲线（进行中商机金额、赢单率）和待办排序改快之后，和原来的写法对拍（2026-10-24 企业版压测）。
 *
 * 旧金额 / 旧赢单率 是 dashboard/Board.tsx 原来那两段、旧排序 是 lib/dashboard-todo.ts 原来的比较函数，一字没改搬过来当基准。
 *   - 随机商机：四种状态、金额带小数和负数（浮点合计的顺序要一样）、两个币种；三成建档时刻落在周界上（正好、前后 1 毫秒）
 *   - 时区：Asia/Shanghai、Europe/London、America/New_York；本机时钟和北京业务钟（MULTI_TENANT=1）各一遍
 *   - 跨月、跨年、夏令时切换的「现在」
 *   - 空数据、全是一种状态
 *   - 待办：没排时间、只排日期、排了钟点、不合法的日期串（排到最后）、同一时刻一大片靠 id 定先后
 */
import { describe, it, expect, afterAll } from "vitest";
import { dayjs } from "@/lib/utils";
import { 最近8周, 每周进行中金额, 每周赢单率 } from "@/lib/dashboard-trend";
import { 按先后排 } from "@/lib/dashboard-todo";
import { scheduleOrder } from "@/lib/schedule-date";
import type { Dayjs } from "dayjs";

type 商机 = { createdAt: Date; status: string; amount: number; 币: string };
const 本位币 = "CNY";
const 商机币种 = (o: 商机) => o.币;

function 旧金额(周: { 止: Dayjs }[], oppsForSeries: 商机[]) {
  return 周.map((w) =>
    Math.round(
      oppsForSeries
        .filter((o) => o.status === "OPEN" && dayjs(o.createdAt).isBefore(w.止) && 商机币种(o) === 本位币)
        .reduce((sum, o) => sum + o.amount, 0) / 1000,
    ),
  );
}

function 旧赢单率(周: { 止: Dayjs }[], oppsForSeries: 商机[]) {
  return 周.map((w) => {
    const 已关闭 = oppsForSeries.filter(
      (o) => (o.status === "WON" || o.status === "LOST") && dayjs(o.createdAt).isBefore(w.止),
    );
    const 赢 = 已关闭.filter((o) => o.status === "WON").length;
    return 已关闭.length ? Math.round((赢 / 已关闭.length) * 100) : 0;
  });
}

const 旧排序 = (a: { id: string; dueAt: string | null }, b: { id: string; dueAt: string | null }) =>
  scheduleOrder(a.dueAt) - scheduleOrder(b.dueAt) || a.id.localeCompare(b.id);

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

function 造商机(周: { 起: Dayjs; 止: Dayjs }[], now: Dayjs, 种子: number, 个数: number): 商机[] {
  const r = 随机(种子);
  const 界: number[] = [now.valueOf()];
  for (const w of 周) for (const t of [w.起.valueOf(), w.止.valueOf()]) 界.push(t, t - 1, t + 1);
  const 状态 = ["OPEN", "OPEN", "WON", "LOST", "PAUSED"];
  return Array.from({ length: 个数 }, () => ({
    createdAt: new Date(r() < 0.3 ? 界[Math.floor(r() * 界.length)] : now.valueOf() + Math.floor((r() * 1.1 - 1) * 70 * 天)),
    status: 状态[Math.floor(r() * 状态.length)],
    // 带小数、偶尔负数（冲销），量级差很多：浮点合计换个顺序就可能差一点
    amount: r() < 0.1 ? -Math.round(r() * 1e5) / 100 : r() < 0.5 ? Math.round(r() * 1e9) / 100 : r() * 1e3,
    币: r() < 0.8 ? "CNY" : "USD",
  }));
}

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

describe("看板小曲线：新写法和原来的写法输出一模一样", () => {
  for (const tz of 时区们) {
    for (const 钟 of 时钟们) {
      it(`${tz} · ${钟.名}`, () => {
        设环境(tz, 钟.MULTI_TENANT);
        expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(tz);
        现在们.forEach((iso, k) => {
          const now = dayjs(new Date(iso));
          const 周 = 最近8周(now);
          const 商机们 = 造商机(周, now, 2000 + k, 600);
          expect(每周进行中金额(周, 商机们, (o) => 商机币种(o) === 本位币), `金额 · 现在=${iso}`).toEqual(旧金额(周, 商机们));
          expect(每周赢单率(周, 商机们), `赢单率 · 现在=${iso}`).toEqual(旧赢单率(周, 商机们));
        });
      }, 60_000);
    }
  }

  it("空数据、全是一种状态", () => {
    设环境("Asia/Shanghai", undefined);
    const now = dayjs(new Date("2026-10-20T03:15:00Z"));
    const 周 = 最近8周(now);
    const 算 = (o: 商机) => 商机币种(o) === 本位币;
    expect(每周进行中金额(周, [], 算)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(每周赢单率(周, [])).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    const 全部 = 造商机(周, now, 7, 300);
    for (const s of ["OPEN", "WON", "LOST", "PAUSED"]) {
      const 一种 = 全部.map((o) => ({ ...o, status: s }));
      expect(每周进行中金额(周, 一种, 算), s).toEqual(旧金额(周, 一种));
      expect(每周赢单率(周, 一种), s).toEqual(旧赢单率(周, 一种));
    }
  });

  it("大一点的量（2 万条商机）也一致", () => {
    设环境("Asia/Shanghai", undefined);
    const now = dayjs(new Date("2026-10-20T03:15:00Z"));
    const 周 = 最近8周(now);
    const 商机们 = 造商机(周, now, 42, 20_000);
    expect(每周进行中金额(周, 商机们, (o) => 商机币种(o) === 本位币)).toEqual(旧金额(周, 商机们));
    expect(每周赢单率(周, 商机们)).toEqual(旧赢单率(周, 商机们));
  });
});

describe("待办排序：每行只解析一次，次序和原来的比较函数一模一样", () => {
  function 造待办(种子: number, 个数: number) {
    const r = 随机(种子);
    const 起 = Date.parse("2026-10-20T00:00:00Z");
    const 编号 = (i: number) => [`task:t${种子}-${i}`, `plan:P${种子}x${i}`, `task:t${种子}_${i}`, `plan:cp${i}`][i % 4];
    return Array.from({ length: 个数 }, (_, i) => {
      const 型 = r();
      const dueAt =
        型 < 0.15
          ? null
          : 型 < 0.45
            ? `2026-10-${String(19 + Math.floor(r() * 6)).padStart(2, "0")}`
            : 型 < 0.5
              ? ["下周", "2026-02-30", "", "2026-13-01"][Math.floor(r() * 4)]
              : new Date(起 + Math.floor(r() * 6) * 天 + [0, 0, 9 * 3600_000, Math.floor(r() * 天)][Math.floor(r() * 4)]).toISOString();
      return { id: 编号(i), dueAt, 第: i };
    });
  }

  for (const tz of 时区们) {
    for (const 钟 of 时钟们) {
      it(`${tz} · ${钟.名}`, () => {
        设环境(tz, 钟.MULTI_TENANT);
        expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(tz);
        for (const 种子 of [1, 2, 3, 4, 5]) {
          const 行 = 造待办(种子, 400);
          // 连同一个原位置编号一起比：稳定排序下同键的行先后也必须一样
          expect(按先后排(行).map((x) => x.第), `种子 ${种子}`).toEqual([...行].sort(旧排序).map((x) => x.第));
        }
      });
    }
  }

  it("空、一条、全是同一时刻", () => {
    设环境("Asia/Shanghai", undefined);
    expect(按先后排([])).toEqual([]);
    expect(按先后排([{ id: "a", dueAt: null }])).toEqual([{ id: "a", dueAt: null }]);
    const 同刻 = Array.from({ length: 50 }, (_, i) => ({ id: `x${(i * 37) % 50}`, dueAt: "2026-10-20" }));
    expect(按先后排(同刻)).toEqual([...同刻].sort(旧排序));
    const 没时间 = Array.from({ length: 50 }, (_, i) => ({ id: `y${(i * 13) % 50}`, dueAt: i % 2 ? null : "不是日期" }));
    expect(按先后排(没时间)).toEqual([...没时间].sort(旧排序));
  });
});
