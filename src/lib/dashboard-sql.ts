import type { Dayjs } from "dayjs";
import type { PrismaClient } from "@/generated/prisma";
import { dayjs } from "@/lib/utils";
import { 近90天趋势, 最近8周, 每周新增, type 趋势点 } from "@/lib/dashboard-trend";
import { 带币种 } from "@/lib/money-db";

/**
 * 看板上「数客户」的那几样（近 90 天两条线、本月 / 上月新增、每周新增），在库里按天先数好再取回来。
 *
 * 原来是把全部客户的建档时刻和 120 天的跟进全取回来在 JS 里数：企业版 10 万客户、20 万跟进时
 * 光取行和建对象就要两三秒，30 人同时开首页就排成长队（2026-10-24 压测 p95 十几秒）。
 * 现在库里只回几百行「第几天有几个」，口径和 lib/dashboard-trend.ts 一模一样：
 *
 * - 「那一天」仍是 dayjs 按本地时区算出的零点：零点在 JS 里一个个算好（夏令时那天也对），
 *   以字面数字写进 SQL，库里只做「落在哪两个零点之间」的比较，不用 SQLite 自己的时区。
 * - 需要的边界（每天零点、往前第 30 天、周起止、月初）任何一个不在这串零点里，就退回原来的取行算法。
 *
 * 只在**不限定**（老板、个人版、企业版没开按组织看）时走这里：裸 SQL 不过 lib/team-scope 的那层 where，
 * 业务员看到的数必须照旧由取行算法在限定后的行上算。tests/dashboard-sql.test.ts 拿取行算法对拍。
 */

export type 客户数 = {
  trend: 趋势点[];
  本月新增: number;
  上月新增: number;
  每周新增: number[];
};

/**
 * 日期列取成毫秒：Prisma 写进 SQLite 的 DateTime 是整数毫秒；
 * 同步或老数据里可能是文本（ISO 串），一并换算，免得漏数或报错
 */
export const 毫秒 = (列: string) =>
  `CASE WHEN typeof(${列}) IN ('integer','real') THEN ${列} ELSE CAST(round((julianday(${列}) - 2440587.5) * 86400000) AS INTEGER) END`;

/**
 * 「t 落在第几天」：零点[j] ≤ t < 零点[j+1] 是第 j 天；早于第一个零点是 -1，晚于最后一个是最后一个的下标。
 * 二分写成嵌套 CASE，每行约 7 次整数比较
 */
export function 第几天(t: string, 零点: number[], lo = 0, hi = 零点.length): string {
  // 在 [lo, hi) 里找最后一个 ≤ t 的下标；lo 处已知 ≤ t（lo = 0 时另判 -1）
  if (hi - lo <= 1) return String(lo);
  const mid = (lo + hi) >> 1;
  return `CASE WHEN ${t} < ${零点[mid]} THEN ${第几天(t, 零点, lo, mid)} ELSE ${第几天(t, 零点, mid, hi)} END`;
}

const 一天 = 86_400_000;

/**
 * 同一个「第几天」，每天正好 24 小时（这段里没有夏令时切换）时直接除出来：
 * 10 万行时比嵌套 CASE 快三成。不均匀就返回 null，用嵌套 CASE。
 * t 必须已知 ≥ 零点[0]；晚于最后一个零点的封顶到最后一个下标；
 * t 为 NULL（文本日期解析不出）时也落到最后一个下标——嵌套 CASE 里 NULL 比较全走 ELSE，也是它
 */
function 除出第几天(t: string, 零点: number[]): string | null {
  for (let i = 1; i < 零点.length; i++) if (零点[i] - 零点[i - 1] !== 一天) return null;
  const 末 = 零点.length - 1;
  return `coalesce(min(CAST((${t} - ${零点[0]}) / ${一天} AS INTEGER), ${末}), ${末})`;
}

/** 已知 t ≥ 零点[0] 时的第几天：能除就除 */
const 不早于起点的第几天 = (t: string, 零点: number[]) => 除出第几天(t, 零点) ?? 第几天(t, 零点);
const 第几天或负一 = (t: string, 零点: number[]) => `CASE WHEN ${t} < ${零点[0]} THEN -1 ELSE ${不早于起点的第几天(t, 零点)} END`;

/** 活跃窗口的天数：近90天趋势 里「> 当天往前第 30 天」 */
const 窗口 = 30;

type 计划 = {
  零点: number[];
  下标: Map<number, number>;
  当天: number[];
  周: { 起: number; 止: number; 起ms: number }[];
  月初: number;
  上月初: number;
  标签: string[];
  跟进起: Date;
};

/** 算好所有边界；有任何一个对不上就返回 null，调用方退回取行 */
function 排边界(now: Dayjs): 计划 | null {
  const 周 = 最近8周(now);
  const 最晚 = Math.max(now.add(1, "day").startOf("day").valueOf(), 周[7].止.valueOf());
  const 零点: number[] = [];
  for (let b = now.subtract(120, "day").startOf("day"); ; b = b.add(1, "day").startOf("day")) {
    const v = b.valueOf();
    if (!Number.isSafeInteger(v) || (零点.length && v <= 零点[零点.length - 1])) return null;
    零点.push(v);
    if (v > 最晚) break;
    if (零点.length > 400) return null;
  }
  const 下标 = new Map(零点.map((v, i) => [v, i]));
  const 找 = (d: Dayjs) => 下标.get(d.startOf("day").valueOf());
  const 当天: number[] = [];
  const 标签: string[] = [];
  for (let i = 0; i < 90; i++) {
    const d = now.subtract(89 - i, "day");
    const D = 找(d);
    const W = 找(d.subtract(窗口, "day"));
    // 当天必须有「下一个零点」，窗口起点必须正好早 30 个零点：滑窗算法靠这个
    if (D === undefined || W === undefined || D - W !== 窗口 || D + 1 >= 零点.length) return null;
    当天.push(D);
    标签.push(d.format("MM-DD"));
  }
  const 周下标: 计划["周"] = [];
  for (const w of 周) {
    const 起 = 下标.get(w.起.valueOf());
    const 止 = 下标.get(w.止.valueOf());
    if (起 === undefined || 止 === undefined) return null;
    周下标.push({ 起, 止, 起ms: w.起.valueOf() });
  }
  const 月初 = 下标.get(now.startOf("month").valueOf());
  const 上月初 = 下标.get(now.subtract(1, "month").startOf("month").valueOf());
  if (月初 === undefined || 上月初 === undefined) return null;
  return { 零点, 下标, 当天, 周: 周下标, 月初, 上月初, 标签, 跟进起: now.subtract(120, "day").toDate() };
}

const 数 = (x: unknown) => Number(x ?? 0);

async function 库里数(db: PrismaClient, 计: 计划): Promise<客户数> {
  const { 零点 } = 计;
  const 周起 = 计.周.map((w) => w.起ms).join(",");
  const [建档, 活跃] = await Promise.all([
    db.$queryRawUnsafe<{ k: bigint | number; e: bigint | number; n: bigint | number }[]>(
      `SELECT k, e, count(*) AS n FROM (
         SELECT ${第几天或负一("t", 零点)} AS k, (t IN (${周起})) AS e
         FROM (SELECT ${毫秒("createdAt")} AS t FROM Customer)
       ) GROUP BY k, e`,
    ),
    db.$queryRawUnsafe<{ k: bigint | number; v: bigint | number }[]>(
      `WITH f AS (SELECT ${毫秒("occurredAt")} AS t, customerId AS c FROM FollowUp WHERE occurredAt >= ?),
       p AS (SELECT DISTINCT c, ${不早于起点的第几天("t", 零点)} AS d FROM f WHERE t >= ${零点[0]}),
       q AS (SELECT d, LAG(d) OVER (PARTITION BY c ORDER BY d) AS pr FROM p)
       SELECT k, sum(v) AS v FROM (
         SELECT CASE WHEN pr IS NULL OR pr + ${窗口} < d THEN d ELSE pr + ${窗口} END AS k, 1 AS v FROM q
         UNION ALL SELECT d + ${窗口}, -1 FROM q
       ) GROUP BY k`,
      计.跟进起.getTime(),
    ),
  ]);

  // 每天的建档数（下标 -1 放在 [0]），和「正好在某周起点那一刻」的条数
  const 偏 = 1;
  const 每天 = new Array<number>(零点.length + 偏).fill(0);
  const 正好起点 = new Map<number, number>();
  for (const r of 建档) {
    const k = 数(r.k);
    每天[k + 偏] += 数(r.n);
    if (数(r.e)) 正好起点.set(k, (正好起点.get(k) ?? 0) + 数(r.n));
  }
  const 累计 = 每天.slice();
  for (let i = 1; i < 累计.length; i++) 累计[i] += 累计[i - 1];
  /** 下标 ≤ k 的总数 */
  const 至 = (k: number) => (k + 偏 < 0 ? 0 : 累计[Math.min(k + 偏, 累计.length - 1)]);
  const 总 = 累计[累计.length - 1];

  const 变化 = new Map<number, number>();
  for (const r of 活跃) 变化.set(数(r.k), 数(r.v));
  // 最大的当天之前的前缀和就够了
  const 活跃至: number[] = [];
  let s = 0;
  for (let k = 0; k <= 计.当天[计.当天.length - 1]; k++) {
    s += 变化.get(k) ?? 0;
    活跃至.push(s);
  }

  return {
    trend: 计.当天.map((D, i) => ({ label: 计.标签[i], created: 至(D), active: 活跃至[D] })),
    本月新增: 总 - 至(计.月初 - 1),
    上月新增: 至(计.月初 - 1) - 至(计.上月初 - 1),
    每周新增: 计.周.map((w) => 至(w.止 - 1) - 至(w.起 - 1) - (正好起点.get(w.起) ?? 0)),
  };
}

/** 取行算法：业务员（限定后的行）和边界对不上时用，就是原来 Board 里那一段 */
export async function 取行数(db: PrismaClient, now: Dayjs): Promise<客户数> {
  const monthStart = now.startOf("month").toDate();
  const lastMonthStart = now.subtract(1, "month").startOf("month").toDate();
  const [客户, 跟进] = await Promise.all([
    db.customer.findMany({ select: { createdAt: true } }),
    db.followUp.findMany({
      select: { customerId: true, occurredAt: true },
      where: { occurredAt: { gte: now.subtract(120, "day").toDate() } },
    }),
  ]);
  return {
    trend: 近90天趋势(now, 客户, 跟进),
    // 含月初零点那一刻（>=），和客户列表「本月新增」的筛选一个口径（排查 C3）
    本月新增: 客户.filter((c) => !dayjs(c.createdAt).isBefore(monthStart)).length,
    上月新增: 客户.filter((c) => !dayjs(c.createdAt).isBefore(lastMonthStart) && dayjs(c.createdAt).isBefore(monthStart)).length,
    每周新增: 每周新增(最近8周(now), 客户),
  };
}

/**
 * 看板的客户数。`不限定` 由调用方按 lib/team-scope 判（限定的我 为 null）：
 * 不限定才在库里数，否则取行（行已经过限定那层 where）
 */
export async function 客户数(db: PrismaClient, now: Dayjs, 不限定: boolean): Promise<客户数> {
  const 计 = 不限定 ? 排边界(now) : null;
  return 计 ? 库里数(db, 计) : 取行数(db, now);
}

/** 首页那一份「全部商机」要的列：赢单窗口、漏斗、两条小曲线都从这一份里挑 */
const 商机列 = { createdAt: true, updatedAt: true, amount: true, stage: true, status: true, closed: { select: { closedAt: true } }, ...带币种.商机 } as const;

export type 商机行 = {
  createdAt: Date;
  updatedAt: Date;
  amount: number;
  stage: string;
  status: string;
  closed: { closedAt: Date } | null;
  money: { currency: string } | null;
};

/**
 * 首页的全部商机（2026-10-25）。原来是 Prisma 带两个一对一关联（赢单时刻、币种）整表取：
 * 企业版 1 万商机时，关联要另发查询、再在 Node 里一行行拼对象，单次 60 多毫秒，几乎全是 CPU。
 * 不限定时改成一句 LEFT JOIN 取回来再拼成原来的形状，约 18 毫秒；行、值、顺序和原来一样。
 *
 * - 「有没有这一行关联」看关联表的主键是不是 NULL，不看值：和 Prisma 的 closed / money 是不是 null 一个口径
 * - 日期列裸 SQL 也按列类型（DATETIME）换成 Date：整数毫秒、ISO 文本、「YYYY-MM-DD HH:MM:SS」老数据和 Prisma 换算得一样
 * - 顺序：两边都是不排序的整表扫，按 rowid 出；金额是浮点，合计的先后顺序要和原来一样，ORDER BY rowid 钉住
 *
 * 业务员（限定的我 不为 null）照旧走 Prisma：裸 SQL 不过 lib/team-scope 的那层 where。
 * tests/dashboard-opps.test.ts 拿 Prisma 那一路对拍
 */
export async function 全部商机(db: PrismaClient, 不限定: boolean): Promise<商机行[]> {
  if (!不限定) return db.opportunity.findMany({ select: 商机列 });
  const 行 = await db.$queryRawUnsafe<
    { createdAt: Date; updatedAt: Date; amount: number; stage: string; status: string; cid: string | null; closedAt: Date | null; mid: string | null; currency: string | null }[]
  >(
    `SELECT o.createdAt, o.updatedAt, o.amount, o.stage, o.status, c.opportunityId AS cid, c.closedAt, m.opportunityId AS mid, m.currency
     FROM Opportunity o LEFT JOIN OpportunityClose c ON c.opportunityId = o.id LEFT JOIN OpportunityMoney m ON m.opportunityId = o.id
     ORDER BY o.rowid`,
  );
  return 行.map((r) => ({
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    amount: r.amount,
    stage: r.stage,
    status: r.status,
    closed: r.cid === null ? null : { closedAt: r.closedAt as Date },
    money: r.mid === null ? null : { currency: r.currency as string },
  }));
}

/** 测试用 */
export const _内部 = { 排边界, 库里数, 第几天, 除出第几天, 商机列 };
