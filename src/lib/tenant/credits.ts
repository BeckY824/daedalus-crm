import { randomUUID } from "node:crypto";
import { control } from "./control";

/**
 * AI 免费次数的赠送账本。
 *
 * 同一套规则，两种归属方：
 *   workspace —— 托管版网页端：一个团队一个工作区，次数按工作区算（和定价口径一致，
 *                按人头算的话拉五个同事进来就有五份）
 *   account   —— 桌面端本地模式：数据在用户自己机器上，我们只认账号，次数按人算
 *
 * 规则对标 eigent：注册送 30；余额不足 30 的，当天有使用就送 3（一天一次）。
 * 余额 = 赠送之和 − 用掉次数。赠送只加不减。
 *
 * 原来还有一档「填邀请码再送 50」，整套码 2026-09-15 下线时一起去掉了。
 * 运营台的「AI +10」还在——要给谁多送几次，那条路更直接，也不用先发一个码出去。
 *
 * 为什么两种归属方分了两张表却共用这一份实现：控制面的迁移只能加表不能改表
 * （SQLite 没有 ADD COLUMN IF NOT EXISTS，而 control-migrations/ 每次启动整个重跑），
 * 而 AiGrant 已经按 workspaceId 建好了。表分开，规则只有一份——
 * 规则要是抄两遍，改定价时必然漏一边。
 *
 * ---
 *
 * **account 这一路还有第三个维度：机器**（2026-09-19）。
 *
 * 在这之前一个账号一份 30 次，而账号是网页上自助注册的——同一台电脑上再注册一个号
 * 就是再送 30 次，没有任何约束。现在 account 归属方的**注册赠送要一台机器发一次**：
 * 哪个账号领走了这台机器那一份，记在 MachineSignup 表里（主键是加盐 sha256 的
 * 硬件 UUID，控制面不存可还原的硬件标识符，见 desktop/machine.js）。
 *
 * 三件事跟着定死，少一件这个闸门就是虚的：
 *
 *   1. **注册赠送只在拿得到机器哈希的调用点上发。** 现在只有一处：
 *      桌面端登录（api/account/token）。那是唯一一个客户端必然经过、
 *      并且带着机器信息的地方。
 *   2. **不知道是哪台机器 → 不发**，不是「照发」。这里最容易写反：
 *      `/api/gateway/v1/credits`、网关的 chat 接口都只认一枚令牌、拿不到机器，
 *      要是它们也照旧补注册赠送，那把请求里的机器字段删掉就又是白送，
 *      这整件事等于没做。不发不等于不能用——每日赠送照结，见下面 结算赠送()。
 *   3. **只加不减。** 已经发出去的赠送一条都不动：改法只是「新的那一条还发不发」，
 *      所以改版之后没有任何人的余额会变少。
 *
 * workspace 那一路完全不看机器：一个工作区好几个同事、各自好几台电脑，
 * 机器在那边不构成任何口径。那一支的代码和改动之前一字不差。
 */

export type Owner = { kind: "workspace"; id: string } | { kind: "account"; id: string };

export const 注册赠送 = 30;
export const 每日赠送 = 3;
/** 余额低于这个数，当天才送。攒着不用的人不会无限累积 */
export const 每日赠送门槛 = 30;

/**
 * 机器哈希长什么样：加盐 sha256 的十六进制，64 位。
 *
 * 规整放在账本这一层而不是各个路由里：它是账本的规矩，抄到调用点上迟早两处不一致。
 * 不是这个样子的（空、短一截、大小写混着、根本不是十六进制）**一律当「不知道是哪台机器」**，
 * 不当成一台叫这个名字的机器——否则随手编一个字符串就能占住一台机器的名额，
 * 或者反过来，所有编错的客户端挤在同一个"机器"上互相挡。
 */
export function 规整机器哈希(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

/** 每日赠送的「天」按北京时间算，和服务器时区、用户所在地都无关，免得跨时区的人一天领两次 */
export function 今天(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * 记一笔赠送。带幂等键的重复调用静默跳过（返回 false），由唯一索引替我们判，
 * 不先查再插——两个标签页同时打开首页时，先查再插会送两遍。
 */
export async function 赠送(owner: Owner, input: { amount: number; reason: string; key?: string; note?: string }): Promise<boolean> {
  if (input.amount <= 0) return false;
  const data = { amount: input.amount, reason: input.reason, key: input.key ?? randomUUID(), note: input.note ?? null };
  try {
    if (owner.kind === "workspace") await control.aiGrant.create({ data: { ...data, workspaceId: owner.id } });
    else await control.accountAiGrant.create({ data: { ...data, accountId: owner.id } });
    return true;
  } catch {
    return false;
  }
}

export async function 赠送总和(owner: Owner): Promise<number> {
  const r =
    owner.kind === "workspace"
      ? await control.aiGrant.aggregate({ where: { workspaceId: owner.id }, _sum: { amount: true } })
      : await control.accountAiGrant.aggregate({ where: { accountId: owner.id }, _sum: { amount: true } });
  return r._sum.amount ?? 0;
}

export async function 用掉次数(owner: Owner): Promise<number> {
  const u =
    owner.kind === "workspace"
      ? await control.aiUsage.findUnique({ where: { workspaceId: owner.id } })
      : await control.accountAiUsage.findUnique({ where: { accountId: owner.id } });
  return u?.calls ?? 0;
}

/** 原子自增，返回自增后的值。不先读再写：两个标签页同时问会各读到 29、各写 30 */
export async function 自增用量(owner: Owner): Promise<number> {
  const after =
    owner.kind === "workspace"
      ? await control.aiUsage.upsert({ where: { workspaceId: owner.id }, create: { workspaceId: owner.id, calls: 1 }, update: { calls: { increment: 1 } } })
      : await control.accountAiUsage.upsert({ where: { accountId: owner.id }, create: { accountId: owner.id, calls: 1 }, update: { calls: { increment: 1 } } });
  return after.calls;
}

/** 超额被拦下的那一次要还回去，否则被拦十次之后补的十次等于白补 */
export async function 回退一次(owner: Owner): Promise<void> {
  if (owner.kind === "workspace") await control.aiUsage.update({ where: { workspaceId: owner.id }, data: { calls: { decrement: 1 } } });
  else await control.accountAiUsage.update({ where: { accountId: owner.id }, data: { calls: { decrement: 1 } } });
}

/**
 * 占住这台机器的注册赠送名额。抢到了（或者本来就是自己的）返回 true。
 *
 * 不先查再插：两台设备、或者一个人连点两次登录，先查再插会两边都判「没人占」。
 * 主键冲突就说明已经有主了，那时再读一次看是不是自己——
 * **是自己也算占住**，否则「插完机器、发赠送之前进程被杀」这种情形会把自己挡在门外，
 * 那台机器的名额就永远悬着、谁也拿不到。
 */
async function 占住机器(machineHash: string, accountId: string): Promise<boolean> {
  try {
    await control.machineSignup.create({ data: { machineHash, accountId } });
    return true;
  } catch {
    const row = await control.machineSignup.findUnique({ where: { machineHash } });
    return row?.accountId === accountId;
  }
}

/**
 * account 归属方的注册赠送：一台机器发一次。
 *
 * 顺序是刻意的——**先看这个账号有没有领过，领过就到此为止，一个字都不写机器表**。
 * 这一句同时管住两种情形：
 *
 *   - 同一个人在同一台电脑上退出再登录、或者一天登十次：`key` 已经在了，
 *     直接返回，既不会重复发，也不会重复占。
 *   - 同一个人换台电脑登录：他早就领过了，于是**不去占新那台机器的名额**——
 *     「占住一台机器」和「发出一份注册赠送」严格一对一。不这样的话，
 *     一个老账号换到家里的共用电脑上登一次，就会把那台电脑的 30 次白白烧掉，
 *     家里第二个人再注册就什么都没有，而我们并没有多发出去一份。
 *     反过来也成立：换电脑不会让他领不到本该有的额度，他的那份还在账上。
 */
async function 结算注册赠送(accountId: string, 机器: string | null | undefined): Promise<void> {
  const key = `${accountId}:signup`;
  if (await control.accountAiGrant.findUnique({ where: { key } })) return;

  const hash = 规整机器哈希(机器);
  // 不知道是哪台机器就不发。理由见文件头第 2 条——这是整个改动最容易写反的一句
  if (!hash) return;
  // 这台机器的那一份已经被别的账号领走了
  if (!(await 占住机器(hash, accountId))) return;

  await 赠送({ kind: "account", id: accountId }, {
    amount: 注册赠送,
    reason: "signup",
    key,
    // 留一句给客服查「他为什么只有 3 次」。只记哈希的头一截，够对得上，也还是不可还原
    note: `机器 ${hash.slice(0, 12)}`,
  });
}

/**
 * 结一次账：该补的注册赠送补上，今天还没领、余额又不足门槛的领一份。
 *
 * 注册赠送在这里补而不是只在注册时发，是为了让改版之前就存在的工作区和账号
 * 不需要任何数据迁移就自动进入新规则。
 *
 * `机器` 是这次请求来自哪台机器（加盐 sha256 的硬件 UUID，桌面端登录时带上来）：
 *   - workspace 归属方**完全不看它**，那边没有机器这个口径；
 *   - account 归属方**没有它就不发注册赠送**（每日赠送照发）。
 *     所以拿不到机器信息的调用点（网关的 credits / chat：它们只认一枚令牌）
 *     不传就对了——不传等于不发，而不是白送。见文件头那三条。
 */
export async function 结算赠送(owner: Owner, 机器?: string | null): Promise<void> {
  if (owner.kind === "workspace") {
    await 赠送(owner, { amount: 注册赠送, reason: "signup", key: `${owner.id}:signup` });
  } else {
    await 结算注册赠送(owner.id, 机器);
    // 付费订阅那一份（个人版每月 N 次）。懒发放：付款时发一次，之后每次结账顺手补。
    // 桌面端那条线没有我们的定时任务够得着的地方——用户的机器可能一个月才开一次，
    // cron 发出去的次数他也用不上。
    // 动态 import 是为了避开 billing → credits → billing 的循环依赖（同 ai-allowance 的写法）。
    const { 结算订阅次数, 订阅中 } = await import("@/lib/billing/orders");
    await 结算订阅次数(owner.id);
    // **订阅期内不再发每日那 3 次。** 和工作区那一侧一个道理（付费的根本不走结算）：
    // 每日赠送是给试用的人续命的，付了钱的人用超了该买加购包。
    // 照发的话「每月 300 次」就不是 300——每天再多 3 次，一个月白多 90。
    if (await 订阅中(owner.id)) return;
  }
  const [送, 用] = await Promise.all([赠送总和(owner), 用掉次数(owner)]);
  if (送 - 用 >= 每日赠送门槛) return;
  await 赠送(owner, { amount: 每日赠送, reason: "daily", key: `${owner.id}:daily:${今天()}` });
}

/**
 * 注册赠送那一份到底发出去了没有。
 *
 * 为什么要单独有这么一个函数，而不是拿「上限 < 30」倒推：**倒推会越推越错**。
 * 每日赠送每天加 3，攒上十天，一个从没拿到注册赠送的账号上限也超过 30 了。
 * 而这个事实要用来对人解释「你为什么只有 3 次」，说错比不说更糟。
 *
 * workspace 那一路永远为真：那边不看机器，注册赠送在 结算赠送() 里无条件发。
 */
export async function 注册赠送发过吗(owner: Owner): Promise<boolean> {
  const key = `${owner.id}:signup`;
  const row =
    owner.kind === "workspace"
      ? await control.aiGrant.findUnique({ where: { key } })
      : await control.accountAiGrant.findUnique({ where: { key } });
  return !!row;
}

/** 只看不扣 */
export async function 余额(owner: Owner): Promise<{ 上限: number; 用掉: number; 还剩: number }> {
  const [送, 用] = await Promise.all([赠送总和(owner), 用掉次数(owner)]);
  // 拦下的那次会还回去，但并发的瞬间计数可能短暂超过上限，对外夹一下
  return { 上限: 送, 用掉: Math.min(用, 送), 还剩: Math.max(0, 送 - 用) };
}

/**
 * 扣一次。放行返回 ok，超了返回还剩多少（0）。
 *
 * 扣在真正发起模型调用**之前**：失败的那次也算。限的是"发起"而不是"成功"，
 * 否则一个反复失败的问题可以无限重试，而每次重试都是真金白银的上游调用。
 * 先自增再判断，超了再还回去——顺序反过来在并发下会多放行。
 *
 * **这里不带机器信息，也不该带**：扣费的入口只认一枚令牌，机器是登录那一刻的事。
 * 于是 account 归属方在这条路上只结每日赠送，注册赠送一分都不发——
 * 想让这条路也能发，就等于给了一个「不带机器就白送」的后门。
 * 实际也不缺：桌面端必须先登录才拿得到令牌，注册赠送在那一步就结过了。
 */
/**
 * 一个问题最多允许几次模型调用。
 *
 * agent 一个问题最多跑 6 步（lib/agent/run.ts 的 MAX_STEPS），加上「吐的不是答案」
 * 那两次重答，正常上限在 9 上下。12 是宽到不会误伤的地板。
 *
 * 超过它不是拒绝，是**当作新的一个问题再扣一次**——拒绝会把人正在等的回答打断，
 * 而多扣一次只是少一次额度。宁可少收一点钱，也不要在回答到一半时把门关上。
 * 它同时是那道防滥用的闸：客户端拿同一个 requestId 无限调用，扣费照样会跟上。
 */
export const 每问最多步 = 12;

/**
 * 规整客户端给的问题编号。
 *
 * 只认 1–64 位的 `[A-Za-z0-9_-]`（uuid、cuid、随机串都在里面）。不是这个样子的一律当
 * **没给**——退回「每次调用扣一次」的老路，而不是拿一个奇怪的字符串去建索引行。
 * 规整放在账本这一层，和 规整机器哈希 同一个道理：抄到各个路由里迟早两处不一致。
 */
export function 规整请求id(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}

export type 扣的结果 = { ok: true; 还剩: number; 扣了: boolean } | { ok: false; 上限: number };

/**
 * 按**一个问题**扣一次。
 *
 * 价格页的原话是「一次提问算一次」，而这条路一直按网关请求扣——agent 回答一个问题
 * 要跑好几步，每步一次请求。2026-09-21 实测：6 个提问吃掉 39 次额度。
 * 这个函数就是那句承诺的实现：
 *
 *   没带 requestId  →  老路，每次调用扣一次（老版本桌面端、第三方 OpenAI 客户端）
 *   第一次见到它    →  扣一次，记一行
 *   同一个 id 再来  →  **不扣**，只把步数加一
 *   退过 / 步数超了 →  当作新的一个问题，重新扣
 *
 * 返回里多一个 `扣了`：调用方拿它决定上游失败时要不要退（没扣过的那几步不用退）。
 *
 * **不抛。** 记账这一层出问题不该让用户的提问失败——建行失败时按「扣了」返回，
 * 最坏的情况是这个问题退回老口径，而不是问不出来。
 */
export async function 按问题扣一次(owner: Owner, requestId: string | null): Promise<扣的结果> {
  if (!requestId) {
    const r = await 扣一次(owner);
    return r.ok ? { ok: true, 还剩: r.还剩, 扣了: true } : r;
  }
  const where = { ownerKind_ownerId_requestId: { ownerKind: owner.kind, ownerId: owner.id, requestId } };

  let 已有: { id: string; calls: number; refunded: boolean } | null = null;
  try {
    已有 = await control.aiCharge.findUnique({ where, select: { id: true, calls: true, refunded: true } });
  } catch (e) {
    // 查不动就退回老口径：宁可多扣一次，也不要因为账本抖了一下让人问不出话
    console.warn("[credits] 问题编号查不动，按老口径扣：", e instanceof Error ? e.message : e);
    const r = await 扣一次(owner);
    return r.ok ? { ok: true, 还剩: r.还剩, 扣了: true } : r;
  }

  // 同一个问题的后续几步：不扣，只计数
  if (已有 && !已有.refunded && 已有.calls < 每问最多步) {
    await control.aiCharge.update({ where: { id: 已有.id }, data: { calls: { increment: 1 } } }).catch(() => {});
    const b = await 余额(owner);
    return { ok: true, 还剩: b.还剩, 扣了: false };
  }

  const r = await 扣一次(owner);
  if (!r.ok) return r;
  try {
    if (已有) await control.aiCharge.update({ where: { id: 已有.id }, data: { calls: 1, refunded: false, at: new Date() } });
    else await control.aiCharge.create({ data: { ownerKind: owner.kind, ownerId: owner.id, requestId } });
  } catch (e) {
    // 并发下两步同时到、都没查到行：后到的那个建不上（唯一索引）。它已经扣过了，
    // 就让它这么算——多扣一次，不至于让这一步失败
    console.warn("[credits] 问题编号记不上：", e instanceof Error ? e.message : e);
  }
  return { ok: true, 还剩: r.还剩, 扣了: true };
}

/**
 * 把这一次退还。**只在「我们这边没给出东西」时调**：上游超时、5xx、429、连不上。
 *
 * 不退的两种：用户自己中断（上游已经在跑了，钱花掉了），以及本来就没扣的那几步。
 *
 * 幂等靠 `refunded` 这个标记：同一个问题重试几次只退一次。没有 requestId 的老路
 * 没有幂等可言——那条路上一次调用就是一次，退就完了。
 */
export async function 退这一次(owner: Owner, requestId: string | null, 扣了: boolean): Promise<void> {
  if (!扣了) return;
  if (!requestId) {
    await 回退一次(owner);
    return;
  }
  try {
    const n = await control.aiCharge.updateMany({
      where: { ownerKind: owner.kind, ownerId: owner.id, requestId, refunded: false },
      data: { refunded: true },
    });
    if (n.count === 1) await 回退一次(owner);
  } catch (e) {
    console.warn("[credits] 退这一次没退成：", e instanceof Error ? e.message : e);
  }
}

export async function 扣一次(owner: Owner): Promise<{ ok: true; 还剩: number } | { ok: false; 上限: number }> {
  await 结算赠送(owner);
  const 上限 = await 赠送总和(owner);
  const after = await 自增用量(owner);
  if (after > 上限) {
    await 回退一次(owner);
    return { ok: false, 上限 };
  }
  return { ok: true, 还剩: 上限 - after };
}
