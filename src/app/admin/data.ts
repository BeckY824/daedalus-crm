import { control } from "@/lib/tenant/control";
import { fmtDate } from "@/lib/utils";
import { 系统名, 数设备, type 设备分布 } from "@/lib/tenant/device-info";

/**
 * 运营台要的数，全在服务端算好，页面只负责画。
 *
 * 量很小（账号两位数、调用每天几百条），所以取回来在内存里拼，不写 SQL 分组——
 * 按北京时间分天要绕 strftime，而这里一眼能读懂比快几毫秒要紧。哪天量上来了再换。
 *
 * **按天的序列一律补零**：缺了的日子不能从横轴上消失，那样走势是假的（2026-09-19 趋势图那次）。
 */

const 天毫秒 = 86_400_000;

/** 本机时区的 YYYY-MM-DD。线上容器 TZ=Asia/Shanghai，和人看报表的口径一致 */
const 日 = (d: Date) => fmtDate(d);

/** 从今天往前数 n 天（含今天）的每一天，旧的在前 */
export function 近几天(n: number, now = new Date()): string[] {
  const 今 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Array.from({ length: n }, (_, i) => 日(new Date(今.getTime() - (n - 1 - i) * 天毫秒 + 12 * 3_600_000)));
}

/** 一串带时间的东西 → 近 n 天每天几个（补零） */
export function 按天数(时间们: Date[], n: number, now = new Date()): { 日: string; 数: number }[] {
  const 桶 = new Map(近几天(n, now).map((d) => [d, 0]));
  for (const t of 时间们) {
    const k = 日(t);
    if (桶.has(k)) 桶.set(k, 桶.get(k)! + 1);
  }
  return [...桶.entries()].map(([d, 数]) => ({ 日: d, 数 }));
}

export const 功能名: Record<string, string> = {
  ask: "提问",
  brief: "简报",
  draft: "话术",
  parse: "速记解析",
  paste: "粘贴整理",
  import: "导入猜列",
  other: "其它",
};
export const 功能名之 = (f: string | null) => (f ? 功能名[f] ?? f : "未标注");

/** 赠送的来路。账本里的 reason 是给程序看的，这里翻给人 */
export const 赠送来路: Record<string, string> = { signup: "注册赠送", daily: "每日赠送", admin: "运营台加的", subscription: "订阅" };

export type 设备行 = {
  id: string;
  name: string;
  系统: ReturnType<typeof 系统名>;
  arch: string | null;
  version: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
};

export type 账号行 = {
  id: string;
  name: string;
  contact: string;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** 最近一次动静：登录，或者任何一台设备用令牌 */
  最近活跃: string | null;
  来路: "桌面端" | "网页版";
  ai: { 送: number; 用: number; 剩: number };
  /** 还有效的设备（吊销过的不算「他手上有几台」） */
  设备: 设备行[];
  分布: 设备分布;
  /** 在用的设备里最新的那个版本；一个都没报过就是 null */
  版本: string | null;
  近30天调用: number;
};

/** 版本号比大小。三段数字，别按字符串比（0.46.10 < 0.46.9 那种） */
export function 比版本(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const 更晚 = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

/** 所有账号，一个账号一行，带上设备、AI 余额和近 30 天调用 */
export async function 读账号们(now = new Date()): Promise<账号行[]> {
  const 起 = new Date(now.getTime() - 30 * 天毫秒);
  const [账号们, 赠送, 用量, 令牌们, 调用] = await Promise.all([
    control.account.findMany({ orderBy: { createdAt: "desc" }, take: 500, include: { memberships: { select: { workspaceId: true } } } }),
    control.accountAiGrant.groupBy({ by: ["accountId"], _sum: { amount: true } }),
    control.accountAiUsage.findMany(),
    control.deviceToken.findMany({ select: { id: true, accountId: true, name: true, createdAt: true, lastUsedAt: true, revokedAt: true } }),
    control.aiCall.groupBy({ by: ["ownerId"], where: { ownerKind: "account", at: { gte: 起 } }, _count: { _all: true } }),
  ]);
  const 信息 = new Map(
    (await control.deviceInfo.findMany({ where: { deviceTokenId: { in: 令牌们.map((t) => t.id) } } })).map((d) => [d.deviceTokenId, d]),
  );
  const 送表 = new Map(赠送.map((g) => [g.accountId, g._sum.amount ?? 0]));
  const 用表 = new Map(用量.map((u) => [u.accountId, u.calls]));
  const 调用表 = new Map(调用.map((c) => [c.ownerId, c._count._all]));
  const 设备表 = new Map<string, 设备行[]>();
  for (const t of 令牌们) {
    const i = 信息.get(t.id);
    const 行: 设备行 = {
      id: t.id,
      name: t.name,
      系统: 系统名(i?.platform),
      arch: i?.arch ?? null,
      version: i?.version ?? null,
      createdAt: t.createdAt.toISOString(),
      lastUsedAt: iso(t.lastUsedAt),
      revoked: Boolean(t.revokedAt),
    };
    设备表.set(t.accountId, [...(设备表.get(t.accountId) ?? []), 行]);
  }

  return 账号们.map((a) => {
    const 送 = 送表.get(a.id) ?? 0;
    const 用 = 用表.get(a.id) ?? 0;
    // 在用的在前、吊销过的垫底；同一组里最近用过的在前
    const 全部设备 = (设备表.get(a.id) ?? []).sort(
      (x, y) => Number(x.revoked) - Number(y.revoked) || (y.lastUsedAt ?? y.createdAt).localeCompare(x.lastUsedAt ?? x.createdAt),
    );
    const 在用 = 全部设备.filter((d) => !d.revoked);
    const 版本们 = 在用.map((d) => d.version).filter((v): v is string => Boolean(v));
    return {
      id: a.id,
      name: a.name,
      contact: a.phone ?? a.email ?? "",
      active: a.active,
      createdAt: a.createdAt.toISOString(),
      lastLoginAt: iso(a.lastLoginAt),
      最近活跃: 在用.reduce((m, d) => 更晚(m, d.lastUsedAt), iso(a.lastLoginAt)),
      来路: a.memberships.length > 0 ? "网页版" : "桌面端",
      ai: { 送, 用, 剩: Math.max(0, 送 - 用) },
      设备: 全部设备,
      分布: 数设备(在用.map((d) => ({ platform: d.系统 === "Mac" ? "darwin" : d.系统 === "Windows" ? "win32" : d.系统 === "Linux" ? "linux" : null }))),
      版本: 版本们.sort(比版本).at(-1) ?? null,
      近30天调用: 调用表.get(a.id) ?? 0,
    };
  });
}

/** 送过、而且用光了。没送过的不算——那是「没有过」，不是「用完了」 */
export const 用完了 = (a: { ai: { 送: number; 剩: number } }) => a.ai.送 > 0 && a.ai.剩 === 0;

export type 总览数 = {
  账号: 账号行[];
  新注册7天: number;
  活跃7天: number;
  设备: 设备分布;
  版本分布: { 版本: string; 台数: number }[];
  注册趋势: { 日: string; 数: number }[];
  调用趋势: { 日: string; 数: number; token: number }[];
  功能分布: { 功能: string; 次数: number }[];
  调用30天: number;
  token30天: number;
  工作区: { 共: number; 试用中: number };
  反馈: { 没处理: number; 最新: { id: string; at: string; body: string; who: string | null }[] };
};

export async function 读总览(now = new Date()): Promise<总览数> {
  const 起 = new Date(now.getTime() - 30 * 天毫秒);
  const [账号, 调用, 工作区们, 没处理, 最新反馈] = await Promise.all([
    读账号们(now),
    control.aiCall.findMany({ where: { at: { gte: 起 } }, select: { at: true, feature: true, inputTokens: true, outputTokens: true }, take: 100_000 }),
    control.workspace.findMany({ select: { status: true, trialEndsAt: true, paidUntil: true } }),
    control.feedback.count({ where: { handled: false } }),
    control.feedback.findMany({ where: { handled: false }, orderBy: { at: "desc" }, take: 4, select: { id: true, at: true, body: true, who: true } }),
  ]);
  const 七天前 = new Date(now.getTime() - 7 * 天毫秒).toISOString();

  // 调用按天：次数和 token 一起算，悬停时两样都给
  const 天们 = 近几天(30, now);
  const 桶 = new Map(天们.map((d) => [d, { 数: 0, token: 0 }]));
  const 功能 = new Map<string, number>();
  let token30天 = 0;
  for (const c of 调用) {
    const t = c.inputTokens + c.outputTokens;
    token30天 += t;
    const b = 桶.get(日(c.at));
    if (b) {
      b.数++;
      b.token += t;
    }
    const k = 功能名之(c.feature);
    功能.set(k, (功能.get(k) ?? 0) + 1);
  }

  const 在用设备 = 账号.flatMap((a) => a.设备.filter((d) => !d.revoked));
  const 版本 = new Map<string, number>();
  for (const d of 在用设备) 版本.set(d.version ?? "未知", (版本.get(d.version ?? "未知") ?? 0) + 1);

  return {
    账号,
    新注册7天: 账号.filter((a) => a.createdAt >= 七天前).length,
    活跃7天: 账号.filter((a) => a.最近活跃 && a.最近活跃 >= 七天前).length,
    设备: 数设备(在用设备.map((d) => ({ platform: d.系统 === "Mac" ? "darwin" : d.系统 === "Windows" ? "win32" : d.系统 === "Linux" ? "linux" : null }))),
    // 新版本在前，「未知」垫底：它是还没升级上来的那一批，不是一个版本
    版本分布: [...版本.entries()]
      .map(([v, n]) => ({ 版本: v, 台数: n }))
      .sort((a, b) => (a.版本 === "未知" ? 1 : b.版本 === "未知" ? -1 : 比版本(b.版本, a.版本))),
    注册趋势: 按天数(账号.map((a) => new Date(a.createdAt)), 30, now),
    调用趋势: 天们.map((d) => ({ 日: d, ...桶.get(d)! })),
    功能分布: [...功能.entries()].map(([k, n]) => ({ 功能: k, 次数: n })).sort((a, b) => b.次数 - a.次数),
    调用30天: 调用.length,
    token30天,
    工作区: {
      共: 工作区们.length,
      试用中: 工作区们.filter((w) => w.status === "TRIAL" && w.trialEndsAt > now && !(w.paidUntil && w.paidUntil > now)).length,
    },
    反馈: { 没处理, 最新: 最新反馈.map((f) => ({ id: f.id, at: f.at.toISOString(), body: f.body, who: f.who })) },
  };
}

export type 用户详情 = {
  账号: 账号行;
  赠送流水: { id: string; at: string; 来路: string; 数: number; note: string | null }[];
  调用趋势: { 日: string; 数: number; token: number }[];
  功能分布: { 功能: string; 次数: number }[];
  模型分布: { 模型: string; 次数: number; token: number }[];
  调用30天: number;
  token30天: number;
  反馈: { id: string; at: string; body: string; path: string | null; version: string | null; handled: boolean }[];
  机器数: number;
};

export async function 读用户(id: string, now = new Date()): Promise<用户详情 | null> {
  const 账号 = (await 读账号们(now)).find((a) => a.id === id);
  if (!账号) return null;
  const 起 = new Date(now.getTime() - 30 * 天毫秒);
  const [流水, 调用, 反馈, 机器数] = await Promise.all([
    control.accountAiGrant.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" }, take: 200 }),
    control.aiCall.findMany({ where: { ownerKind: "account", ownerId: id, at: { gte: 起 } }, select: { at: true, feature: true, model: true, inputTokens: true, outputTokens: true } }),
    control.feedback.findMany({ where: { accountId: id }, orderBy: { at: "desc" }, take: 50 }),
    control.machineSignup.count({ where: { accountId: id } }),
  ]);
  const 天们 = 近几天(30, now);
  const 桶 = new Map(天们.map((d) => [d, { 数: 0, token: 0 }]));
  const 功能 = new Map<string, number>();
  const 模型 = new Map<string, { 次数: number; token: number }>();
  let token30天 = 0;
  for (const c of 调用) {
    const t = c.inputTokens + c.outputTokens;
    token30天 += t;
    const b = 桶.get(日(c.at));
    if (b) {
      b.数++;
      b.token += t;
    }
    const k = 功能名之(c.feature);
    功能.set(k, (功能.get(k) ?? 0) + 1);
    const m = 模型.get(c.model || "（未知）") ?? { 次数: 0, token: 0 };
    m.次数++;
    m.token += t;
    模型.set(c.model || "（未知）", m);
  }
  return {
    账号,
    赠送流水: 流水.map((g) => ({ id: g.id, at: g.createdAt.toISOString(), 来路: 赠送来路[g.reason] ?? g.reason, 数: g.amount, note: g.note })),
    调用趋势: 天们.map((d) => ({ 日: d, ...桶.get(d)! })),
    功能分布: [...功能.entries()].map(([k, n]) => ({ 功能: k, 次数: n })).sort((a, b) => b.次数 - a.次数),
    模型分布: [...模型.entries()].map(([k, v]) => ({ 模型: k, ...v })).sort((a, b) => b.次数 - a.次数),
    调用30天: 调用.length,
    token30天,
    反馈: 反馈.map((f) => ({ id: f.id, at: f.at.toISOString(), body: f.body, path: f.path, version: f.version, handled: f.handled })),
    机器数,
  };
}

/** 导航上「反馈」旁边那个红数 */
export async function 反馈没处理数(): Promise<number> {
  return control.feedback.count({ where: { handled: false } });
}

export type 反馈条 = {
  id: string;
  at: string;
  source: string;
  body: string;
  path: string | null;
  version: string | null;
  platform: string | null;
  who: string | null;
  accountId: string | null;
  handled: boolean;
};

export async function 读反馈(): Promise<反馈条[]> {
  const 行 = await control.feedback.findMany({ orderBy: { at: "desc" }, take: 300 });
  return 行.map((f) => ({
    id: f.id,
    at: f.at.toISOString(),
    source: f.source,
    body: f.body,
    path: f.path,
    version: f.version,
    platform: f.platform,
    who: f.who,
    accountId: f.accountId,
    handled: f.handled,
  }));
}

export type 工作区行 = {
  id: string;
  slug: string;
  name: string;
  status: string;
  writable: boolean;
  daysLeft: number;
  /** 共享工作区的 trialEndsAt 在 2100 年：天数报出来是 26764，每天变一次、永远没有意义 */
  长期: boolean;
  createdAt: string;
  paidUntil: string | null;
  members: number;
  owner: { name: string; contact: string } | null;
  ai: { 送: number; 剩: number };
  note: string | null;
};

export async function 读工作区们(): Promise<工作区行[]> {
  const { computeWritable, daysLeft, 长期有效 } = await import("@/lib/tenant/workspaces");
  const [rows, 赠送, 用量] = await Promise.all([
    control.workspace.findMany({ orderBy: { createdAt: "desc" }, take: 200, include: { memberships: { include: { account: true } } } }),
    control.aiGrant.groupBy({ by: ["workspaceId"], _sum: { amount: true } }),
    control.aiUsage.findMany(),
  ]);
  const 送表 = new Map(赠送.map((g) => [g.workspaceId, g._sum.amount ?? 0]));
  const 用表 = new Map(用量.map((u) => [u.workspaceId, u.calls]));
  return rows.map((w) => {
    const owner = w.memberships.find((m) => m.role === "OWNER")?.account;
    const 送 = 送表.get(w.id) ?? 0;
    return {
      id: w.id,
      slug: w.slug,
      name: w.name,
      status: w.status,
      writable: computeWritable(w),
      daysLeft: daysLeft(w),
      长期: 长期有效(daysLeft(w)),
      createdAt: w.createdAt.toISOString(),
      paidUntil: w.paidUntil ? w.paidUntil.toISOString() : null,
      members: w.memberships.length,
      owner: owner ? { name: owner.name, contact: owner.phone ?? owner.email ?? "" } : null,
      ai: { 送, 剩: Math.max(0, 送 - (用表.get(w.id) ?? 0)) },
      note: w.note,
    };
  });
}

/** 模型用量页：按功能分（成本概览 里没有这一维） */
export async function 读功能分布(天数: number, now = new Date()): Promise<{ 功能: string; 次数: number; token: number }[]> {
  const 起 = new Date(now.getTime() - 天数 * 天毫秒);
  const 行 = await control.aiCall.findMany({ where: { at: { gte: 起 } }, select: { feature: true, inputTokens: true, outputTokens: true }, take: 100_000 });
  const 桶 = new Map<string, { 次数: number; token: number }>();
  for (const c of 行) {
    const k = 功能名之(c.feature);
    const b = 桶.get(k) ?? { 次数: 0, token: 0 };
    b.次数++;
    b.token += c.inputTokens + c.outputTokens;
    桶.set(k, b);
  }
  return [...桶.entries()].map(([功能, v]) => ({ 功能, ...v })).sort((a, b) => b.次数 - a.次数);
}
