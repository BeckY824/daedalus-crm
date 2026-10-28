/**
 * 盯盘清单的取数：从库里捞出三类原料，交给 sentinel.ts 的纯规则打分。
 * 首页（AI 对话的建议 chip）和数据看板（盯盘卡片）共用，避免两处各写一遍查询。
 */
import { 订单节点 } from "@/lib/features";
import { scheduleValue } from "./schedule-date";
import { 今天零点, 逾期条件 } from "./overdue";
import { prisma, defaultClient } from "./prisma";
import { 限定的我 } from "./team-scope";
import { 毫秒, 第几天 } from "./dashboard-sql";
import { 缓存着 } from "./home-cache";
import { 开船节点 } from "./order-track";
import { dayjs } from "./utils";
import type { Dayjs } from "dayjs";
import { buildWatchlist, 盯盘排序, STALE_DAYS, STATUS_WEIGHT, type SentinelInput, type WatchItem } from "./sentinel";
import { getBusiness } from "./business";
import { statusLabel, stageLabel, type BusinessConfig } from "./business-config";

/** 沉睡客户那一段的取法：全取回来交给 buildWatchlist 判（老路），或库里只取前几名 + 准确总数 */
type 沉睡取法 = { 前几名: number } | null;

/**
 * `范围.ownerId` 给了就只看这个人名下的，**先筛再排序**（排查 C7）：
 * 原来首页先取全团队前 8 位、再按姓名筛出「我的」，我的那几位排不进全团队前 8 就数漏了，重名的还会混在一起。
 *
 * 返回的 `items` 只保证前 `取法.前几名` 条和全量算法一样（老路时是全部）；`total` 总是准确的总数
 */
async function allWatchlist(now = dayjs(), 范围: { ownerId?: string } = {}, 取法: 沉睡取法 = null): Promise<{ items: WatchItem[]; total: number }> {
  const 谁的 = 范围.ownerId;
  /*
    沉睡客户、停滞商机先在库里粗筛一道（2026-10-24 企业版压测：10 万客户全取回来再算天数要一秒多）。
    只筛掉「肯定不到 STALE_DAYS 天」的：最近那一刻离现在不到 12 个 24 小时，
    不管哪个时区、按日历天怎么数（夏令时那天 23 / 25 小时）也到不了 14 天。到没到 14 天仍由 buildWatchlist 照原样判
  */
  const 肯定没睡 = new Date(now.valueOf() - (STALE_DAYS - 2) * 86_400_000);
  const 边界 = 取法 ? 沉睡边界(now) : null;
  const businessP = getBusiness();
  const 判 = (input: SentinelInput, business: BusinessConfig) =>
    buildWatchlist(input, now.toDate(), business.customer, (v) => statusLabel(business, v), Infinity);

  if (!边界) {
    const [别的, customers, business] = await Promise.all([取别的({ 谁的, now, 肯定没睡, businessP }), 取沉睡客户({ 谁的, 肯定没睡, now }), businessP]);
    const items = 判({ ...别的, customers }, business);
    return { items, total: items.length };
  }

  // 库里取前几名：沉睡的前几名、总数不看别的几样，和下面几样一起先开查，取回 id 接着取这几位客户
  const 沉睡q = 沉睡查询({ 谁的, now, 边界, 前几名: 取法!.前几名 });
  const 前几P = 沉睡q.前几和总数();
  const 沉睡行P = 前几P.then((x) => 取沉睡客户({ 谁的, 肯定没睡, now, ids: x.ids }));
  /*
    别的几样（逾期计划、停滞商机、订单节点）照旧全判，知道它们涉及哪些客户才数得准总数。
    判好的清单和「两边都有的」个数进短时缓存（lib/home-cache.ts，企业版才开，库一变就作废）：
    不分前几名，30 人同一时刻判的是同一份（2026-10-25 企业版压测：逾期计划 5000 条时首页每次多 130 ms，
    取计划连客户、负责人 54 ms，判两遍 32 ms，再加几千个 id 查重叠）。
    原料只按日子变（逾期、超期按今天零点，天数按日历天，都是业务钟；商机那道粗筛只筛掉怎么也到不了 14 天的），key 里带业务日零点。
    重叠那句和沉睡那句一样含「此刻」（跟进时间写在未来的客户），同样随缓存最多晚 30 秒
  */
  const 别的P = 缓存着(`盯盘别的:${谁的 ?? ""}:${今天零点(now.toDate()).valueOf()}`, async () => {
    const [别的, business] = await Promise.all([取别的({ 谁的, now, 肯定没睡, businessP }), businessP]);
    const 清单 = 判({ ...别的, customers: [] }, business);
    const 按客户 = new Map(清单.map((x) => [x.customerId, x]));
    return { 清单, 按客户, 重叠: await 沉睡q.重叠([...按客户.keys()]) };
  });
  const [前几, 别的判, 沉睡行, business] = await Promise.all([前几P, 别的P, 沉睡行P, businessP]);
  const 沉睡 = 判({ overduePlans: [], opportunities: [], customers: 沉睡行 }, business);
  return { items: 合并(别的判, 沉睡, 取法!.前几名), total: 前几.沉睡 + 别的判.按客户.size - 别的判.重叠 };
}

/** 逾期计划、停滞商机、订单节点三样原料 */
async function 取别的(a: { 谁的?: string; now: Dayjs; 肯定没睡: Date; businessP: Promise<BusinessConfig> }): Promise<Omit<SentinelInput, "customers">> {
  const { 谁的, now, 肯定没睡 } = a;
  const [overduePlans, opps, 超期节点, business] = await Promise.all([
    prisma.followPlan.findMany({
      // 逾期按今天零点算，和首页、左栏角标、计划页一个口径（lib/overdue.ts）：今天上午没做的还算今天的
      where: 逾期条件({ ownerId: 谁的 }, now.toDate()).plan,
      select: { subject: true, plannedAt: true, plannedOn: true, customer: { select: { id: true, name: true } }, owner: { select: { name: true } } },
    }),
    prisma.opportunity.findMany({
      where: {
        status: "OPEN",
        ...(谁的 ? { ownerId: 谁的 } : {}),
        // 天数按 activityAt ?? updatedAt 算
        OR: [{ activityAt: { lt: 肯定没睡 } }, { activityAt: null, updatedAt: { lt: 肯定没睡 } }],
      },
      select: { name: true, stage: true, updatedAt: true, activityAt: true, customer: { select: { id: true, name: true } }, owner: { select: { name: true } } },
    }),
    // 订单里超期 / 卡住的节点：截止日早于今天零点（和订单一览的红格同一个口径，lib/order.ts 节点灯）。
    // 订单节点这一版不上（lib/features.ts）就不取：盯盘里不出订单
    !订单节点 ? Promise.resolve([]) : prisma.tradeOrderNode.findMany({
      where: {
        status: { notIn: ["已完成", "不适用"] },
        OR: [{ status: "卡住" }, { dueAt: { lt: 今天零点(now.toDate()) } }],
        // 同 取订单提醒项：按客户现在的负责人，不按下单时固化的业绩归属
        ...(谁的 ? { order: { customer: { salesOwnerId: 谁的 } } } : {}),
      },
      select: { idx: true, name: true, dueAt: true, status: true, order: { select: { id: true, no: true, ownerId: true, customer: { select: { id: true, name: true } } } } },
    }),
    a.businessP,
  ]);
  // 预计到港过了还没到（0.46.30 D-46）：当成「报关 / 开船」那一步后面的一项超期，点进去落在第 11 步
  const 到港过期 = !订单节点 ? [] : await prisma.tradeOrderTrack.findMany({
    where: { ata: null, eta: { lt: 今天零点(now.toDate()) }, ...(谁的 ? { order: { customer: { salesOwnerId: 谁的 } } } : {}) },
    select: { eta: true, order: { select: { id: true, no: true, ownerId: true, customer: { select: { id: true, name: true } } } } },
  });
  const lateNodes = [...超期节点, ...到港过期.map((t) => ({ idx: 开船节点, name: "到港", dueAt: t.eta, status: "进行中", order: t.order }))];
  const 业务员 = new Map(
    (await prisma.user.findMany({ where: { id: { in: [...new Set(lateNodes.map((x) => x.order.ownerId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
  );
  return {
    overduePlans: overduePlans.map((p) => ({ customerId: p.customer.id, customerName: p.customer.name, ownerName: p.owner.name, subject: p.subject, plannedAt: scheduleValue(p.plannedAt, p.plannedOn)! })),
    opportunities: opps.map((o) => ({ customerId: o.customer.id, customerName: o.customer.name, ownerName: o.owner.name, name: o.name, stage: stageLabel(business, o.stage), updatedAt: o.activityAt ?? o.updatedAt })),
    lateOrderNodes: lateNodes.map((x) => ({
      orderId: x.order.id, orderNo: x.order.no, idx: x.idx, nodeName: x.name, dueAt: x.dueAt, 卡住: x.status === "卡住",
      customerId: x.order.customer.id, customerName: x.order.customer.name, ownerName: 业务员.get(x.order.ownerId) ?? "",
    })),
  };
}

/**
 * 别的几样判好的清单（每个客户一条、排好序）和沉睡的合起来，和 buildWatchlist 把两边一起判的结果一样，只要前 n 条。
 * 同一客户两边都有：分高的留下；同分时 buildWatchlist 留先放进去的——计划、订单在沉睡前面，商机在沉睡后面
 * （实际计划 ≥ 100、订单 ≥ 110，沉睡最多 80，只有商机会和沉睡同分）。
 * 两边各自已按 盯盘排序 排好，归并一遍就是整体的顺序，不用把几千条再排一次。
 * 别的那份是缓存里共用的，给出去的是拷贝
 */
function 合并(别的: { 清单: WatchItem[]; 按客户: Map<string, WatchItem> }, 沉睡: WatchItem[], n: number): WatchItem[] {
  const 让掉 = new Set<WatchItem>();
  const 留 = 沉睡.filter((s) => {
    const o = 别的.按客户.get(s.customerId);
    if (!o) return true;
    if (o.score > s.score || (o.score === s.score && o.kind !== "stalled_opp")) return false;
    让掉.add(o);
    return true;
  });
  const 甲 = 别的.清单;
  const out: WatchItem[] = [];
  let i = 0;
  let j = 0;
  while (out.length < n && (i < 甲.length || j < 留.length)) {
    if (i < 甲.length && 让掉.has(甲[i])) i++;
    else if (j >= 留.length || (i < 甲.length && 盯盘排序(甲[i], 留[j]) <= 0)) out.push({ ...甲[i++] });
    else out.push({ ...留[j++] });
  }
  return out;
}

async function 取沉睡客户(a: { 谁的?: string; 肯定没睡: Date; now: Dayjs; ids?: string[] }): Promise<SentinelInput["customers"]> {
  const rows = await prisma.customer.findMany({
    where: {
      followStatus: { notIn: ["已签约", "已流失", "暂缓跟进"], in: Object.keys(STATUS_WEIGHT) },
      ...(a.谁的 ? { salesOwnerId: a.谁的 } : {}),
      ...(a.ids ? { id: { in: a.ids } } : {}),
      // buildWatchlist 按 lastFollowAt 算天数；没跟进过、或跟进日期在未来（录错了）的按 createdAt
      OR: [{ lastFollowAt: { lt: a.肯定没睡 } }, { createdAt: { lt: a.肯定没睡 }, OR: [{ lastFollowAt: null }, { lastFollowAt: { gt: a.now.toDate() } }] }],
    },
    select: { id: true, name: true, followStatus: true, lastFollowAt: true, createdAt: true, salesOwner: { select: { name: true } } },
  });
  return rows.map((c) => ({ id: c.id, name: c.name, followStatus: c.followStatus, lastFollowAt: c.lastFollowAt, createdAt: c.createdAt, ownerName: c.salesOwner.name }));
}

/** 沉睡分数里天数封顶 40（sentinel.ts）：40 天以上都一样 */
const 封顶 = 40;

/**
 * 沉睡天数 14..39 各自的起点零点（升序：第 0 个是「刚好 39 天」那天的零点，最后一个是「刚好 14 天」的下一天零点，即 13 天）。
 * 天数和 buildWatchlist 一样按 dayjs 本地日历天算：零点在 JS 里算好、逐个用 buildWatchlist 的算法验过，
 * 对不上（某个时区那天没有零点之类）就返回 null，调用方退回老路
 */
function 沉睡边界(now: Dayjs): number[] | null {
  const 今天 = dayjs(now.toDate()).startOf("day");
  const 天数 = (t: number) => 今天.diff(dayjs(t).startOf("day"), "day");
  const 零点: number[] = [];
  for (let k = 封顶 - 1; k >= STALE_DAYS - 1; k--) 零点.push(今天.subtract(k, "day").startOf("day").valueOf());
  for (let j = 0; j < 零点.length; j++) {
    const v = 零点[j];
    if (!Number.isSafeInteger(v) || (j > 0 && v <= 零点[j - 1])) return null;
    // 零点那一刻是 39-j 天，前 1 毫秒是 40-j 天：天数随时刻单调，两头对上中间就都对
    if (天数(v) !== 封顶 - 1 - j || 天数(v - 1) !== 封顶 - j) return null;
  }
  return 零点;
}

/**
 * 沉睡客户库里只取前 `前几名` 位 + 准确总数（2026-10-24 企业版压测：4 万多个真沉睡的客户全取回来逐个判要几百毫秒，首页只显示 8 条）。
 *
 * 为什么前几名够用：最终名单按「每个客户最高分」降序、同分按客户 id。只沉睡的客户最终分就是沉睡分，
 * 排在它前面的沉睡客户最终分只会更高，所以最终前 N 名里只沉睡的那些一定在沉睡前 N 名里；
 * 别的几样（计划、商机、订单）照旧全量交给 buildWatchlist，同一客户谁胜出仍由它判。
 * 总数 = 沉睡客户数 + 别的几样涉及的客户数 − 两边都有的。
 *
 * 同分按 id 排：buildWatchlist 是 localeCompare，和库里按字节比不一样（id 有大写、连字符时），
 * 所以库里只按分数取门槛（第 N 名的分），门槛及以上的 id 取回来在 JS 里用同一个比较排。
 * 天数、分数和 sentinel.ts 同一套：状态权重 × 8 + min(天数, 40)，天数按 沉睡边界() 的零点数
 */
function 沉睡查询(a: { 谁的?: string; now: Dayjs; 边界: number[]; 前几名: number }) {
  const 零点 = a.边界;
  const 现在 = a.now.valueOf();
  const 状态 = Object.entries(STATUS_WEIGHT);
  const 字面 = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const 最近 = `CASE WHEN lastFollowAt IS NOT NULL AND ${毫秒("lastFollowAt")} > ${现在} THEN ${毫秒("createdAt")} ELSE COALESCE(${毫秒("lastFollowAt")}, ${毫秒("createdAt")}) END`;
  const 沉睡 = (只这些 = false) => `SELECT id, CASE followStatus ${状态.map(([k, w]) => `WHEN ${字面(k)} THEN ${w}`).join(" ")} END AS w, t FROM (
      SELECT id, followStatus, ${最近} AS t FROM Customer
      WHERE followStatus IN (${状态.map(([k]) => 字面(k)).join(",")})${a.谁的 ? " AND salesOwnerId = ?" : ""}${只这些 ? " AND id IN (SELECT value FROM json_each(?))" : ""}
    ) WHERE t < ${零点[零点.length - 1]}`;
  const 分 = `w * 8 + CASE WHEN t < ${零点[0]} THEN ${封顶} ELSE ${封顶 - 1} - (${第几天("t", 零点)}) END`;
  const 谁 = a.谁的 ? [a.谁的] : [];
  // 前几名和总数不看别的几样，30 人同一时刻数的是同一份：短时缓存（lib/home-cache.ts，企业版才开，库一变就作废）
  const 前几和总数 = () => 缓存着(`沉睡:${a.谁的 ?? ""}:${零点[0]}:${a.前几名}`, async () => {
    const [候选, [数]] = await Promise.all([
      // 第 N 名的分数当门槛，门槛及以上的全取回来（只有 id 和分）：同分的按 localeCompare 排得在 JS 里排
      prisma.$queryRawUnsafe<{ id: string; f: bigint | number }[]>(
        `WITH s AS MATERIALIZED (SELECT id, ${分} AS f FROM (${沉睡()}))
         SELECT id, f FROM s WHERE f >= COALESCE((SELECT f FROM s ORDER BY f DESC LIMIT 1 OFFSET ?), ${Number.MIN_SAFE_INTEGER})`,
        ...谁,
        a.前几名 - 1,
      ),
      prisma.$queryRawUnsafe<{ n: bigint | number }[]>(`SELECT count(*) AS n FROM (${沉睡()})`, ...谁),
    ]);
    // 和 buildWatchlist 同一个比较：分高在前，同分按 customerId.localeCompare
    const ids = 候选
      .map((r) => ({ id: r.id, f: Number(r.f) }))
      .sort((x, y) => y.f - x.f || x.id.localeCompare(y.id))
      .slice(0, a.前几名)
      .map((r) => r.id);
    return { ids, 沉睡: Number(数.n) };
  }).then((x) => ({ ids: x.ids.slice(), 沉睡: x.沉睡 }));
  // 两边都有的：只按别的几样涉及的那些 id 查（主键），不再把全部沉睡客户扫一遍
  const 重叠 = async (别的客户: string[]) => {
    if (!别的客户.length) return 0;
    const [r] = await prisma.$queryRawUnsafe<{ o: bigint | number }[]>(`SELECT count(*) AS o FROM (${沉睡(true)})`, ...谁, JSON.stringify(别的客户));
    return Number(r.o ?? 0);
  };
  return { 前几和总数, 重叠 };
}

async function 沉睡前几名(a: { 谁的?: string; now: Dayjs; 边界: number[]; 前几名: number; 别的客户: string[] }) {
  const q = 沉睡查询(a);
  const [{ ids, 沉睡 }, 重叠] = await Promise.all([q.前几和总数(), q.重叠(a.别的客户)]);
  return { ids, 沉睡, 重叠 };
}

/**
 * 展示窗口与总数分开；返回窗口内的记录，不把全库序列化给客户端。
 *
 * `不限定`（调用方按 lib/team-scope 的 限定的我 判，null 才是不限定）时沉睡客户走库里取前几名：
 * 裸 SQL 不过 team-scope 那层 where，限定的业务员照旧全取回来判
 */
export async function loadWatchlistPage(now = dayjs(), 范围: { ownerId?: string } = {}, offset = 0, limit = 8) {
  const size = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 8;
  const requested = Number.isSafeInteger(offset) ? Math.max(0, offset) : 0;
  const 不限定 = !(await 限定的我(defaultClient));
  const { items: all, total } = await allWatchlist(now, 范围, 不限定 ? { 前几名: requested + size } : null);
  const start = Math.min(requested, Math.max(0, Math.floor((total - 1) / size) * size));
  return { items: all.slice(start, start + size), total, offset: start };
}

/** 兼容既有小卡片调用方。需要总数/更多记录时使用分页入口。 */
export async function loadWatchlist(now = dayjs(), 范围: { ownerId?: string } = {}): Promise<WatchItem[]> {
  return (await loadWatchlistPage(now, 范围)).items;
}

/** 测试用 */
export const _内部 = { 沉睡边界, 沉睡前几名, 合并 };
