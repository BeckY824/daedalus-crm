import { control } from "./control";
import { 测试账号们 } from "./test-accounts";

/**
 * 运营台手动加次数（2026-10-19）。用户原话：「如果有用户和我购买了次数，我可以手动添加。包括AI次数……
 * 团队版……我可以直接增加背调次数+AI次数。个人版就单独做一个页面做这个。」
 *
 * 次数照旧记在 AccountAiGrant（问答的 AI 次数）/ ResearchGrant（背调次数），reason = admin，余额算法一行不改，
 * 桌面端下次读 /api/gateway/v1/credits 就是新数。多记一行 AdminCreditLog：谁加的、从哪个团队页加的。
 *
 * 规矩：
 *   - 只加不减；一次 1–1000 的整数，超出范围直接拒（不偷偷夹到边上：运营以为加了 5000，其实只加了 1000）
 *   - 同一次点击只加一次：弹框打开时生成一个编号（key），赠送那一行和记录那一行都用它，唯一索引替我们判。
 *     连点、网络重发、服务器动作被重放，都是同一个 key，第二次返回「已经加过」，不再加
 *   - 测试账号不限次数，加了也看不出来，拒掉并说清楚（以前是把按钮藏起来，运营者以为「加不了」）
 */
export type 次数种类 = "research" | "ai";
export const 一次最多 = 1000;
const KEY格式 = /^[A-Za-z0-9_-]{8,64}$/;

export type 加次结果 = { ok: true; 重复: boolean } | { ok: false; error: string };

export async function 运营加次(input: {
  accountId: string;
  种类: 次数种类;
  n: number;
  key: string;
  by: string;
  note?: string | null;
  teamId?: string | null;
}): Promise<加次结果> {
  const { accountId, 种类, n, by } = input;
  if (种类 !== "research" && 种类 !== "ai") return { ok: false, error: "加什么次数？" };
  if (!Number.isInteger(n) || n < 1 || n > 一次最多) return { ok: false, error: `一次加 1–${一次最多} 次` };
  if (typeof input.key !== "string" || !KEY格式.test(input.key)) return { ok: false, error: "这次点击没有编号，刷新页面再试" };
  const note = input.note?.trim().slice(0, 200) || null;
  const teamId = input.teamId || null;

  const a = await control.account.findUnique({ where: { id: accountId }, select: { id: true } });
  if (!a) return { ok: false, error: "账号不存在" };
  if ((await 测试账号们()).has(accountId)) return { ok: false, error: "测试账号不限次数，不用加" };
  if (teamId) {
    const m = await control.syncMember.findUnique({ where: { teamId_accountId: { teamId, accountId } } });
    if (!m || m.leftAt) return { ok: false, error: "这个人不在这个团队里了" };
  }

  const 键 = `admin:${input.key}`;
  const 赠送行 = { accountId, amount: n, reason: "admin", key: 键, note: note ?? "运营台" };
  try {
    await control.$transaction([
      种类 === "ai" ? control.accountAiGrant.create({ data: 赠送行 }) : control.researchGrant.create({ data: 赠送行 }),
      control.adminCreditLog.create({ data: { key: 键, accountId, kind: 种类, amount: n, by, note, teamId } }),
    ]);
    return { ok: true, 重复: false };
  } catch (e) {
    // 唯一索引撞了：同一次点击已经加过（整笔回滚，不会多出一半）。编号对得上同一个人、同一种次数才算「加过了」
    const 有 = await control.adminCreditLog.findUnique({ where: { key: 键 } });
    if (有 && 有.accountId === accountId && 有.kind === 种类) return { ok: true, 重复: true };
    if (有) return { ok: false, error: "这次点击的编号已经用过，刷新页面再试" };
    throw e;
  }
}

export type 两种余额 = {
  测试: boolean;
  /** 背调次数：送了 / 用了 / 还剩。和 credits.ts 的 背调余额 同一个算法 */
  背调: { 送: number; 用: number; 剩: number };
  /** 问答的 AI 次数。和 credits.ts 的 余额 同一个算法 */
  ai: { 送: number; 用: number; 剩: number };
};

/** 一批账号的背调 / AI 余额，一次查完（次数页、团队详情页一页几十个人，不一个个查）。测试账号 测试 = true、页面写「不限」 */
export async function 余额们(ids: string[]): Promise<Map<string, 两种余额>> {
  if (!ids.length) return new Map();
  const [ai送, ai用, 背送, 背用, 测试] = await Promise.all([
    control.accountAiGrant.groupBy({ by: ["accountId"], where: { accountId: { in: ids } }, _sum: { amount: true } }),
    control.accountAiUsage.findMany({ where: { accountId: { in: ids } } }),
    control.researchGrant.groupBy({ by: ["accountId"], where: { accountId: { in: ids } }, _sum: { amount: true } }),
    control.aiResearchRun.groupBy({ by: ["ownerId"], where: { ownerKind: "account", ownerId: { in: ids }, refunded: false }, _sum: { units: true } }),
    测试账号们(),
  ]);
  const 表 = <T,>(rows: T[], k: (r: T) => string, v: (r: T) => number) => new Map(rows.map((r) => [k(r), v(r)]));
  const A送 = 表(ai送, (r) => r.accountId, (r) => r._sum.amount ?? 0);
  const A用 = 表(ai用, (r) => r.accountId, (r) => r.calls);
  const B送 = 表(背送, (r) => r.accountId, (r) => r._sum.amount ?? 0);
  const B用 = 表(背用, (r) => r.ownerId, (r) => r._sum.units ?? 0);
  return new Map(
    ids.map((id) => {
      const [as, au, bs, bu] = [A送.get(id) ?? 0, A用.get(id) ?? 0, B送.get(id) ?? 0, B用.get(id) ?? 0];
      return [id, { 测试: 测试.has(id), 背调: { 送: bs, 用: bu, 剩: Math.max(0, bs - bu) }, ai: { 送: as, 用: Math.min(au, as), 剩: Math.max(0, as - au) } }];
    }),
  );
}

export type 加次记录行 = {
  key: string;
  at: string;
  accountId: string;
  账号: string;
  种类: 次数种类;
  数: number;
  by: string | null;
  note: string | null;
  团队: string | null;
};

/**
 * 运营台加过的次数，新的在上。从两张赠送表里 reason = admin 的行出发（10-19 之前加的也在，只是不知道是谁加的），
 * 有 AdminCreditLog 的补上谁、哪个团队。accountIds 给了就只看这几个人（团队详情页）
 */
export async function 加次记录(opts: { accountIds?: string[]; take?: number } = {}): Promise<加次记录行[]> {
  const take = opts.take ?? 100;
  const where = { reason: "admin", ...(opts.accountIds ? { accountId: { in: opts.accountIds } } : {}) };
  const [ai, 背] = await Promise.all([
    control.accountAiGrant.findMany({ where, orderBy: { createdAt: "desc" }, take }),
    control.researchGrant.findMany({ where, orderBy: { createdAt: "desc" }, take }),
  ]);
  const 行们 = [...ai.map((g) => ({ ...g, 种类: "ai" as const })), ...背.map((g) => ({ ...g, 种类: "research" as const }))]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, take);
  const [记, 人] = await Promise.all([
    control.adminCreditLog.findMany({ where: { key: { in: 行们.map((g) => g.key) } } }),
    control.account.findMany({ where: { id: { in: [...new Set(行们.map((g) => g.accountId))] } }, select: { id: true, name: true, email: true, phone: true } }),
  ]);
  const 记表 = new Map(记.map((l) => [l.key, l]));
  const 人表 = new Map(人.map((a) => [a.id, a]));
  const 团队们 = await control.syncTeam.findMany({ where: { id: { in: 记.flatMap((l) => (l.teamId ? [l.teamId] : [])) } }, select: { id: true, name: true } });
  const 团队表 = new Map(团队们.map((t) => [t.id, t.name]));
  return 行们.map((g) => {
    const l = 记表.get(g.key);
    const a = 人表.get(g.accountId);
    return {
      key: g.key,
      at: g.createdAt.toISOString(),
      accountId: g.accountId,
      账号: a ? `${a.name}${a.email || a.phone ? `（${a.email ?? a.phone}）` : ""}` : "（账号已删）",
      种类: g.种类,
      数: g.amount,
      by: l?.by ?? null,
      // 记录那一行的备注是运营者写的原话；老记录只有赠送表上的（没写时是「运营台」）
      note: l ? l.note : g.note,
      团队: l?.teamId ? (团队表.get(l.teamId) ?? "（团队已删）") : null,
    };
  });
}

export type 次数行 = { id: string; name: string; email: string | null; phone: string | null; createdAt: string } & 两种余额;

/** 次数页的搜索：邮箱 / 名字 / 手机里含这几个字（英文不分大小写），最多 50 个；不填就列最近注册的 20 个 */
export async function 搜账号(q: string): Promise<次数行[]> {
  const 词 = q.trim().slice(0, 100);
  const 账号们 = await control.account.findMany({
    where: 词 ? { OR: [{ email: { contains: 词 } }, { name: { contains: 词 } }, { phone: { contains: 词 } }] } : undefined,
    orderBy: { createdAt: "desc" },
    take: 词 ? 50 : 20,
    select: { id: true, name: true, email: true, phone: true, createdAt: true },
  });
  const 余 = await 余额们(账号们.map((a) => a.id));
  return 账号们.map((a) => ({ ...a, createdAt: a.createdAt.toISOString(), ...余.get(a.id)! }));
}

export type 团队成员行 = 次数行 & { role: string; joinedAt: string; 设备: number };

/** 团队详情页：团队本身 + 现在的成员（退出的不列），每人的角色、几台设备、背调 / AI 还剩几次 */
export async function 团队详情(teamId: string) {
  const team = await control.syncTeam.findUnique({ where: { id: teamId } });
  if (!team) return null;
  const 成员 = await control.syncMember.findMany({ where: { teamId, leftAt: null }, orderBy: { joinedAt: "asc" } });
  const ids = 成员.map((m) => m.accountId);
  const [账号们, 设备, 余] = await Promise.all([
    control.account.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true, phone: true, createdAt: true } }),
    control.syncDevice.groupBy({ by: ["accountId"], where: { teamId, accountId: { in: ids } }, _count: { _all: true } }),
    余额们(ids),
  ]);
  const 人表 = new Map(账号们.map((a) => [a.id, a]));
  const 设备表 = new Map(设备.map((d) => [d.accountId, d._count._all]));
  const rows: 团队成员行[] = 成员.flatMap((m) => {
    const a = 人表.get(m.accountId);
    if (!a) return [];
    // 建团队的人排最前，其余按加入先后
    return [{ ...a, createdAt: a.createdAt.toISOString(), ...余.get(a.id)!, role: m.role, joinedAt: m.joinedAt.toISOString(), 设备: 设备表.get(a.id) ?? 0 }];
  }).sort((x, y) => Number(y.role === "owner") - Number(x.role === "owner"));
  return { team: { id: team.id, name: team.name, active: team.active, activatedAt: team.activatedAt?.toISOString() ?? null, createdAt: team.createdAt.toISOString() }, rows };
}
