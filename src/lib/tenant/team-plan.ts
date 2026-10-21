/**
 * 团队版按时长开通（2026-10-15）。
 *
 * 收费走私域、运营者手动开通，不做应用内支付（~/Opensource_CRM/02-开发与发版/团队版收费-方案-20261015.md）。
 * 运营台「团队同步」点「开通 / 续费」：选时长和人数，按价格表算应收，确认后写到期日——
 * 还没到期就从原到期日往后顺延（不吃掉已付的天数），已过期或从没开通从今天算。
 *
 * 到期 = 暂停同步：和「待开通 / 停用」同一道闸（同步闸），收推送、给拉取、范围同步都过它。
 * 每个人电脑上的数据照常能用，续费后自动恢复。没有到期日 = 不限期（10-15 之前开通的老团队）。
 * 席位（2026-10-19 用户拍板要拦，原来只在运营台提示）：客户先说要几人，运营台开通时填的人数就是上限，以后要改找我们改。
 * 满了新成员加入拦下（席位闸）；同一个人加电脑 / 手机不占人数，只在人数已经超过上限（运营台把人数改小了）时拦。
 * 没填人数（10-19 之前开通的老团队）= 只按最多人数（100）拦。运营台改人数下一次请求就生效（每次现查）。
 */
import { control } from "./control";
import type { Prisma } from "@/generated/control";
import { 时长们, 时长名, 月数对, 默认价格, 新到期日, 同步闸, 没开通话, 人满话, 最多人数, type 价格表 } from "@/lib/team-pricing";

export * from "@/lib/team-pricing";

type Db = typeof control | Prisma.TransactionClient;

/** 两位小数以内、0 到 10 万 */
const 价对 = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 100_000 && Math.abs(x * 100 - Math.round(x * 100)) < 1e-6;
const 试用天数对 = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 90;

export async function 读价格(db: Db = control): Promise<价格表> {
  const r = await db.syncPricing.findUnique({ where: { id: "default" } }).catch(() => null);
  if (!r) return 默认价格;
  try {
    const 存的 = JSON.parse(r.prices) as { months: number; perSeat: number }[];
    // 每个时长都要有、价要对；缺了哪个用默认补上，不让桌面端那张表少一行
    const prices = 时长们.map((x) => {
      const p = 存的.find((y) => y.months === x.months)?.perSeat;
      return { months: x.months, perSeat: 价对(p) ? p : 默认价格.prices.find((y) => y.months === x.months)!.perSeat };
    });
    return { prices, trialDays: 试用天数对(r.trialDays) ? r.trialDays : 默认价格.trialDays };
  } catch {
    return 默认价格;
  }
}

export async function 存价格(p: 价格表, by: string): Promise<string | null> {
  if (!Array.isArray(p?.prices)) return "价格表不对";
  for (const x of 时长们) {
    const v = p.prices.find((y) => y.months === x.months)?.perSeat;
    if (!价对(v)) return `「${x.label}」的价不对（0 到 10 万，最多两位小数）`;
  }
  if (!试用天数对(p.trialDays)) return "试用天数要是 0 到 90 的整数";
  const prices = JSON.stringify(时长们.map((x) => ({ months: x.months, perSeat: p.prices.find((y) => y.months === x.months)!.perSeat })));
  await control.syncPricing.upsert({ where: { id: "default" }, update: { prices, trialDays: p.trialDays, updatedAt: new Date(), by }, create: { id: "default", prices, trialDays: p.trialDays, by } });
  return null;
}

/** 给桌面端看的价格表：每人价，再折算成每人每月，买得越久越便宜一眼看得出 */
export async function 公开价格() {
  const p = await 读价格();
  return {
    prices: p.prices.map((x) => ({ months: x.months, label: 时长名(x.months), perSeat: x.perSeat, perMonth: Math.round((x.perSeat / x.months) * 10) / 10 })),
    trialDays: p.trialDays,
  };
}

/** 同步闸，顺手查到期日。离数据最近的那几处（收推送、给拉取、范围同步）都过这一道 */
export async function 能同步(t: { id: string; active: boolean }, db: Db = control, now = new Date()): Promise<string | null> {
  if (!t.active) return 没开通话;
  return 同步闸(t, await db.syncTeamPlan.findUnique({ where: { teamId: t.id } }), now);
}

/**
 * 席位闸：加人 = 有新成员要进来（满了就拦）；不加人 = 本人加一台设备（人数已经超过上限才拦）。
 * 人数按还在队里的成员算（含老板），和运营台「人数 / 席位」那一格同一个数
 */
export async function 席位闸(teamId: string, 加人: boolean, db: Db = control): Promise<string | null> {
  const seats = (await db.syncTeamPlan.findUnique({ where: { teamId }, select: { seats: true } }))?.seats;
  const n = await db.syncMember.count({ where: { teamId, leftAt: null } });
  if (!seats) return 加人 && n >= 最多人数 ? `这个团队已经有 ${最多人数} 个人了` : null;
  return (加人 ? n >= seats : n > seats) ? 人满话(seats) : null;
}

/* ---------------- 运营台的几个动作 ---------------- */

type 结果 = { ok: true; paidUntil: Date | null } | { ok: false; error: string };

/**
 * 开通 / 续费：写到期日和席位、打开同步、留一条记录。
 * 时长：{ months }（1 / 3 / 6 / 12）或 { days }（试用，1–90 天）。amount：实收（元），null = 没收钱（试用、赠送）
 */
export async function 开通续费(
  input: { teamId: string; 时长: { months: number } | { days: number }; seats: number; amount: number | null; note?: string; by: string },
  now = new Date(),
): Promise<结果> {
  const 时长 = input.时长;
  if ("months" in 时长 ? !月数对(时长.months) : !(Number.isInteger(时长.days) && 时长.days >= 1 && 时长.days <= 90)) return { ok: false, error: "时长不对" };
  if (!Number.isInteger(input.seats) || input.seats < 1 || input.seats > 最多人数) return { ok: false, error: `人数要是 1 到 ${最多人数} 的整数` };
  if (input.amount !== null && !价对(input.amount)) return { ok: false, error: "金额不对（最多两位小数）" };
  const note = String(input.note ?? "").trim().slice(0, 200) || null;
  return control.$transaction(async (tx) => {
    const t = await tx.syncTeam.findUnique({ where: { id: input.teamId } });
    if (!t) return { ok: false as const, error: "团队不存在" };
    const plan = await tx.syncTeamPlan.findUnique({ where: { teamId: t.id } });
    const before = plan?.paidUntil ?? null;
    const after = 新到期日(before, 时长, now);
    await tx.syncTeamPlan.upsert({ where: { teamId: t.id }, update: { paidUntil: after, seats: input.seats, updatedAt: now }, create: { teamId: t.id, paidUntil: after, seats: input.seats, updatedAt: now } });
    if (!t.active) await tx.syncTeam.update({ where: { id: t.id }, data: { active: true, activatedAt: now } });
    // 开通过（有过到期日，或以前开过）就算续费：老团队第一次设时长、停用后再开、过期后续上都是续费
    const kind = "days" in 时长 ? "试用" : plan?.paidUntil || t.activatedAt ? "续费" : "开通";
    await tx.syncTeamPlanLog.create({
      data: { teamId: t.id, at: now, by: input.by, kind, months: "months" in 时长 ? 时长.months : null, days: "days" in 时长 ? 时长.days : null, seats: input.seats, amount: input.amount, before, after, note },
    });
    return { ok: true as const, paidUntil: after };
  });
}

/** 只改人数（席位上限），不动到期日（2026-10-19）：客户要加人 / 减人时运营台改，下一次入队、批准设备就按新数拦 */
export async function 改人数(input: { teamId: string; seats: number; note?: string; by: string }, now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isInteger(input.seats) || input.seats < 1 || input.seats > 最多人数) return { ok: false, error: `人数要是 1 到 ${最多人数} 的整数` };
  const note = String(input.note ?? "").trim().slice(0, 200) || null;
  return control.$transaction(async (tx) => {
    const t = await tx.syncTeam.findUnique({ where: { id: input.teamId } });
    if (!t) return { ok: false as const, error: "团队不存在" };
    const plan = await tx.syncTeamPlan.findUnique({ where: { teamId: t.id } });
    await tx.syncTeamPlan.upsert({ where: { teamId: t.id }, update: { seats: input.seats, updatedAt: now }, create: { teamId: t.id, seats: input.seats, updatedAt: now } });
    await tx.syncTeamPlanLog.create({ data: { teamId: t.id, at: now, by: input.by, kind: "改人数", seats: input.seats, before: plan?.paidUntil ?? null, after: plan?.paidUntil ?? null, note: note ?? (plan?.seats ? `原来 ${plan.seats} 人` : null) } });
    return { ok: true as const };
  });
}

/** 手动改到期日（纠错用）。null = 不限期。不动开通状态：停用的还是停用 */
export async function 改到期(input: { teamId: string; paidUntil: Date | null; note?: string; by: string }, now = new Date()): Promise<结果> {
  if (input.paidUntil && Number.isNaN(input.paidUntil.getTime())) return { ok: false, error: "日期不对" };
  const note = String(input.note ?? "").trim().slice(0, 200) || null;
  return control.$transaction(async (tx) => {
    const t = await tx.syncTeam.findUnique({ where: { id: input.teamId } });
    if (!t) return { ok: false as const, error: "团队不存在" };
    const plan = await tx.syncTeamPlan.findUnique({ where: { teamId: t.id } });
    await tx.syncTeamPlan.upsert({ where: { teamId: t.id }, update: { paidUntil: input.paidUntil, updatedAt: now }, create: { teamId: t.id, paidUntil: input.paidUntil, updatedAt: now } });
    await tx.syncTeamPlanLog.create({ data: { teamId: t.id, at: now, by: input.by, kind: "改到期", seats: plan?.seats ?? null, before: plan?.paidUntil ?? null, after: input.paidUntil, note } });
    return { ok: true as const, paidUntil: input.paidUntil };
  });
}

/** 停用：关同步、留记录。到期日不动，之后「开通 / 续费」照常顺延 */
export async function 停用(input: { teamId: string; note?: string; by: string }, now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  return control.$transaction(async (tx) => {
    const t = await tx.syncTeam.findUnique({ where: { id: input.teamId } });
    if (!t) return { ok: false as const, error: "团队不存在" };
    const plan = await tx.syncTeamPlan.findUnique({ where: { teamId: t.id } });
    await tx.syncTeam.update({ where: { id: t.id }, data: { active: false } });
    await tx.syncTeamPlanLog.create({ data: { teamId: t.id, at: now, by: input.by, kind: "停用", seats: plan?.seats ?? null, before: plan?.paidUntil ?? null, after: plan?.paidUntil ?? null, note: String(input.note ?? "").trim().slice(0, 200) || null } });
    return { ok: true as const };
  });
}

/** 运营台列表要的：每个团队的到期日、席位，和最近的操作记录（新的在前） */
export async function 团队们的开通情况(teamIds: string[]) {
  const [plans, logs] = await Promise.all([
    control.syncTeamPlan.findMany({ where: { teamId: { in: teamIds } } }),
    control.syncTeamPlanLog.findMany({ where: { teamId: { in: teamIds } }, orderBy: { at: "desc" }, take: 1000 }),
  ]);
  return { plans: new Map(plans.map((p) => [p.teamId, p])), logs };
}
