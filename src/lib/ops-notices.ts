import { control } from "./tenant/control";
import { 测试账号们 } from "./tenant/test-accounts";

/**
 * 运营通知（2026-10-02）：运营台里有事，**只推给运营名单里那一个账号的桌面端**。
 *
 * 四类：新注册、新反馈、用量异常、新团队待开通（2026-10-07：桌面端有人建了团队，要运营台点「开通」才开始同步，原来没人告诉运营）。壳每两分钟拿设备令牌问一次 /api/ops/notices?since=…，
 * 自己发系统通知；点一下打开运营台对应那一页。门和「运营台…」菜单是同一道（是运营账号），
 * 别的账号问只会拿到 403，壳里也根本不起这个轮询。
 *
 * 规矩照提醒那套：通知少，每一条都要你做点什么。
 *   - 一次来了一堆同类的（睡了一晚上醒来），并成一条「新增 N 个用户」，不刷屏
 *   - 往回最多补 24 小时：放了三天假回来，没必要把三天的事一条条弹出来，运营台里都有
 *   - 用量异常按「谁 + 哪个钟头」成键，同一个钟头只叫一次（去重在壳里，键由这里给）
 *   - 测试账号（含运营账号自己，见 lib/tenant/test-accounts.ts）的注册、用量一律不报（2026-10-04）。
 *     注册那一刻还没来得及标的号照样会报一次——标是事后的事，这条挡不住，也不必挡
 */

export type 运营事件 = {
  /** 去重用：同一个键壳只发一次 */
  key: string;
  kind: "注册" | "反馈" | "用量" | "团队";
  标题: string;
  正文: string;
  /** 点了打开运营台的哪一页，一律 /admin 开头 */
  path: string;
};

/** 往回最多补多久 */
export const 最多补毫秒 = 24 * 3600_000;
/** 同类超过这么多条就并成一条 */
const 并条阈值 = 3;

/**
 * 用量异常的两条线，环境变量可调。默认值是「正常人用不到」的量：一小时 30 个提问、一天 100 万 token。
 * 提问按 AiCharge 数（一个问题一行），不按 AiCall——agent 答一个问题要好几步，按步数会误报。
 */
export function 异常线(env: Record<string, string | undefined> = process.env) {
  const 数 = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return { 每小时提问: 数(env.OPS_ALERT_ASKS_PER_HOUR, 30), 每天token: 数(env.OPS_ALERT_TOKENS_PER_DAY, 1_000_000) };
}

const 截 = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const 一行 = (s: string) => s.replace(/\s+/g, " ").trim();
/** 北京时间的 YYYY-MM-DDTHH / YYYY-MM-DD：键和「今天」都按用户那边的钟点算 */
const 北京 = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString();

/** since 不合法、太早、在未来：都规整到 [now-24h, now] */
export function 规整起点(since: string | null | undefined, now: Date): Date | null {
  if (!since) return null;
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return null;
  return new Date(Math.min(now.getTime(), Math.max(t, now.getTime() - 最多补毫秒)));
}

/** 同类太多就并成一条。用量异常本来就少、而且每条是不同的人，不并，最多留前几条 */
export function 并条(事件: 运营事件[]): 运营事件[] {
  const 出: 运营事件[] = [];
  const 注册 = 事件.filter((e) => e.kind === "注册");
  const 反馈 = 事件.filter((e) => e.kind === "反馈");
  const 用量 = 事件.filter((e) => e.kind === "用量");
  if (注册.length > 并条阈值) {
    出.push({
      key: `${注册[0].key}…${注册.length}`,
      kind: "注册",
      标题: `新增 ${注册.length} 个用户`,
      正文: `${注册.slice(0, 3).map((e) => e.标题.replace(/^新用户：/, "")).join("、")} 等`,
      path: "/admin/users",
    });
  } else 出.push(...注册);
  if (反馈.length > 并条阈值) {
    出.push({ key: `${反馈[0].key}…${反馈.length}`, kind: "反馈", 标题: `${反馈.length} 条新反馈`, 正文: 反馈[0].正文, path: "/admin/feedback" });
  } else 出.push(...反馈);
  出.push(...用量.slice(0, 5));
  // 新团队：每一个都要去点开通，不并条
  出.push(...事件.filter((e) => e.kind === "团队"));
  return 出;
}

/**
 * since 以来的事。没给 since（壳第一次问）就只回一个 now，不补历史——
 * 刚装好就弹一串旧注册，等于告诉人「这东西很吵」。
 */
export async function 读运营通知(since: string | null | undefined, now = new Date(), env: Record<string, string | undefined> = process.env): Promise<{ now: string; 事件: 运营事件[] }> {
  const 起 = 规整起点(since, now);
  if (!起) return { now: now.toISOString(), 事件: [] };

  const 线 = 异常线(env);
  const 一小时前 = new Date(now.getTime() - 3600_000);
  // 「今天」按北京时间零点
  const 今天零点 = new Date(Date.parse(`${北京(now).slice(0, 10)}T00:00:00+08:00`));

  const [测试们, 新账号, 新反馈, 近一小时, 今天, 新团队] = await Promise.all([
    测试账号们(env),
    control.account.findMany({
      where: { createdAt: { gt: 起, lte: now } },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, email: true, phone: true, createdAt: true, memberships: { select: { id: true }, take: 1 } },
    }),
    control.feedback.findMany({ where: { at: { gt: 起, lte: now } }, orderBy: { at: "asc" }, select: { id: true, at: true, body: true, who: true, source: true } }),
    control.aiCharge.groupBy({ by: ["ownerKind", "ownerId"], where: { at: { gt: 一小时前, lte: now }, refunded: false }, _count: { _all: true } }),
    control.aiCall.groupBy({ by: ["ownerKind", "ownerId"], where: { at: { gte: 今天零点, lte: now } }, _sum: { inputTokens: true, outputTokens: true } }),
    // 已经开通了的（运营抢在通知前点了）就不报
    control.syncTeam.findMany({ where: { createdAt: { gt: 起, lte: now }, active: false }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, ownerAccountId: true } }),
  ]);

  const 事件: 运营事件[] = [];
  const 是测试 = (kind: string, id: string) => kind === "account" && 测试们.has(id);
  for (const a of 新账号) {
    if (是测试("account", a.id)) continue;
    事件.push({
      key: `注册:${a.id}`,
      kind: "注册",
      标题: `新用户：${a.name}`,
      正文: [a.email ?? a.phone, a.memberships.length > 0 ? "网页版" : "桌面端"].filter(Boolean).join(" · "),
      path: `/admin/users/${a.id}`,
    });
  }
  for (const f of 新反馈) {
    事件.push({
      key: `反馈:${f.id}`,
      kind: "反馈",
      标题: `新反馈：${f.who || (f.source === "desktop" ? "桌面端用户" : "网页用户")}`,
      正文: 截(一行(f.body), 120),
      path: "/admin/feedback",
    });
  }

  /*
    新团队待开通：桌面端建了团队、把同事拉进来，不开通就一直「团队还没开通，暂不同步」。测试账号建的也报——开通照样要人去点
  */
  if (新团队.length) {
    const 老板们 = new Map(
      (await control.account.findMany({ where: { id: { in: 新团队.map((t) => t.ownerAccountId) } }, select: { id: true, name: true, email: true, phone: true } }))
        .map((a) => [a.id, a.email ?? a.phone ?? a.name] as [string, string]),
    );
    for (const t of 新团队) {
      事件.push({
        key: `团队:${t.id}`,
        kind: "团队",
        标题: `新团队待开通：${截(一行(t.name), 30)}`,
        正文: `${老板们.get(t.ownerAccountId) ?? "有人"} 建的 · 点开去运营台「团队同步」开通`,
        path: "/admin/sync",
      });
    }
  }

  // 用量：超线的才报。键带钟头 / 日期，同一段时间壳只发一次
  const 超的: { kind: string; id: string; 说: string; key: string }[] = [];
  const 钟头 = 北京(now).slice(0, 13);
  for (const g of 近一小时) {
    if (是测试(g.ownerKind, g.ownerId)) continue;
    if (g._count._all >= 线.每小时提问) 超的.push({ kind: g.ownerKind, id: g.ownerId, 说: `近一小时问了 AI ${g._count._all} 次`, key: `用量:时:${g.ownerKind}:${g.ownerId}@${钟头}` });
  }
  const 日 = 北京(now).slice(0, 10);
  for (const g of 今天) {
    if (是测试(g.ownerKind, g.ownerId)) continue;
    const t = (g._sum.inputTokens ?? 0) + (g._sum.outputTokens ?? 0);
    if (t >= 线.每天token) 超的.push({ kind: g.ownerKind, id: g.ownerId, 说: `今天已用 ${(t / 10_000).toFixed(0)} 万 token`, key: `用量:日:${g.ownerKind}:${g.ownerId}@${日}` });
  }
  if (超的.length) {
    const 账号ids = 超的.filter((x) => x.kind === "account").map((x) => x.id);
    const 工作区ids = 超的.filter((x) => x.kind === "workspace").map((x) => x.id);
    const [账号们, 工作区们] = await Promise.all([
      control.account.findMany({ where: { id: { in: 账号ids } }, select: { id: true, name: true, email: true, phone: true } }),
      control.workspace.findMany({ where: { id: { in: 工作区ids } }, select: { id: true, name: true, slug: true } }),
    ]);
    const 名 = new Map<string, string>([
      ...账号们.map((a) => [`account:${a.id}`, a.email ?? a.phone ?? a.name] as [string, string]),
      ...工作区们.map((w) => [`workspace:${w.id}`, `工作区 ${w.slug}`] as [string, string]),
    ]);
    for (const x of 超的) {
      事件.push({
        key: x.key,
        kind: "用量",
        标题: `用量异常：${名.get(`${x.kind}:${x.id}`) ?? x.id}`,
        正文: x.说,
        path: x.kind === "account" ? `/admin/users/${x.id}` : "/admin/workspaces",
      });
    }
  }
  return { now: now.toISOString(), 事件: 并条(事件) };
}
