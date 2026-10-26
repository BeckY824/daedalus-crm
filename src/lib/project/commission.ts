/**
 * 企业版提成（2026-10-26，迁移 051）：算法和取值规整。纯函数，不碰库，界面也能引。
 *
 * 规矩（用户和总控 10-26 定）：
 *   - 底价提成 = 项目底价 × A（默认 2%）；溢价提成 = (成交金额 − 项目底价) × B（默认 30%）。
 *     成交金额低于底价时溢价算 0，不出负数。A、B 是百分数，存 Setting（entCommissionRates），管理员在设置里改
 *   - 成交金额 = 项目上现有的金额（Project.amount，同币种）；项目底价由项目负责人在项目的提成表里填（EntCommission.basePrice；10-26 定，老板也不代填）
 *   - 组长（项目负责人）按百分比分给已进组（JOINED）的组员，合计 ≤ 100%，剩下的归组长
 *   - 赢单（商机 → 订单）那一刻按当时的比例把实际提成固定下来；之前只显示预估
 *
 * 叫法照对方表里的原文：项目底价、成交金额、项目溢价、提成比例；预估提成、实际提成是我们这边的说法。
 * 读写在 commission-db.ts
 */

export type 提成比例 = { 底价比例: number; 溢价比例: number };

/** Setting 里的键 */
export const 提成比例键 = "entCommissionRates";
export const 默认提成比例: 提成比例 = { 底价比例: 2, 溢价比例: 30 };

/** 钱、百分数都留两位小数 */
export function 两位(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 0–100、最多两位小数的百分数；不合规矩返回一句人话 */
export function 百分数问题(v: unknown, 叫法: string): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return `${叫法}要填一个数`;
  if (v < 0 || v > 100) return `${叫法}要在 0% 到 100% 之间`;
  if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) return `${叫法}最多两位小数`;
  return null;
}

/** Setting 里存的 → 能用的比例；缺的、坏的用默认值补（迁移不写数据，默认值在代码里） */
export function 规整提成比例(v: unknown): 提成比例 {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const 取 = (k: keyof 提成比例) => (百分数问题(o[k], k) ? 默认提成比例[k] : (o[k] as number));
  return { 底价比例: 取("底价比例"), 溢价比例: 取("溢价比例") };
}

export function 提成比例问题(v: { 底价比例?: unknown; 溢价比例?: unknown } | null | undefined): string | null {
  return 百分数问题(v?.底价比例, "底价提成比例") ?? 百分数问题(v?.溢价比例, "溢价提成比例");
}

export type 提成算式 = { 成交金额: number; 项目底价: number; 项目溢价: number; 底价提成: number; 溢价提成: number; 合计: number };

/** 按比例算一次提成。底价没填 → null（不出数） */
export function 算提成(成交金额: number | null | undefined, 项目底价: number | null | undefined, 比例: 提成比例): 提成算式 | null {
  if (项目底价 == null || !Number.isFinite(项目底价)) return null;
  const 成交 = Number.isFinite(成交金额) ? (成交金额 as number) : 0;
  const 溢价 = Math.max(0, 两位(成交 - 项目底价));
  const 底价提成 = 两位((项目底价 * 比例.底价比例) / 100);
  const 溢价提成 = 两位((溢价 * 比例.溢价比例) / 100);
  return { 成交金额: 成交, 项目底价, 项目溢价: 溢价, 底价提成, 溢价提成, 合计: 两位(底价提成 + 溢价提成) };
}

/** 项目底价：空 = 清掉；要 ≥ 0、最多两位小数 */
export function 底价问题(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) return "项目底价要填一个数";
  if (v < 0) return "项目底价不能是负数";
  if (v > 1e12) return "项目底价太大了";
  if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) return "项目底价最多两位小数";
  return null;
}

/** 一份分配：组员 id → 百分数。组长自己不占一行 */
export type 分配 = Record<string, number>;

/** 每个人的比例要 0–100，合计（按分算成整数比，免得 0.1 + 0.2 的小数尾巴）不能超过 100% */
export function 分配问题(分: 分配): string | null {
  let 合 = 0;
  for (const v of Object.values(分)) {
    const 错 = 百分数问题(v, "提成比例");
    if (错) return 错;
    合 += Math.round(v * 100);
  }
  return 合 > 10000 ? `合计超过 100%（现在是 ${两位(合 / 100)}%），剩下的才归组长` : null;
}

export type 每人一份 = { userId: string; 比例: number; 金额: number | null; 组长: boolean };

/**
 * 合计按比例分到人：组员各拿自己那份（两位小数），剩下的（含零头）都归组长。
 * 只算还在组里（JOINED）的人：退组、没同意的那份回到组长。合计 null（底价没填）时金额都是 null
 */
export function 分到每人(合计: number | null, 组长: string, 分: { userId: string; percent: number }[], 在组: ReadonlySet<string>): 每人一份[] {
  const 组员 = 分.filter((s) => s.userId !== 组长 && 在组.has(s.userId) && s.percent > 0);
  const 他们 = 组员.map((s) => ({ userId: s.userId, 比例: s.percent, 金额: 合计 == null ? null : 两位((合计 * s.percent) / 100), 组长: false }));
  const 剩比例 = 两位(100 - 组员.reduce((a, s) => a + Math.round(s.percent * 100), 0) / 100);
  const 剩金额 = 合计 == null ? null : 两位(合计 - 他们.reduce((a, s) => a + (s.金额 ?? 0), 0));
  return [{ userId: 组长, 比例: Math.max(0, 剩比例), 金额: 剩金额, 组长: true }, ...他们];
}

/** 项目详情上的提成卡（服务端算好给界面；没开企业版、看不了的人拿到 null） */
export type 提成卡 = {
  币种: string;
  /** 现在项目上的金额；固定了以后看 实际.成交金额 */
  成交金额: number;
  项目底价: number | null;
  /** 现在设置里的比例（预估按它算） */
  比例: 提成比例;
  预估: 提成算式 | null;
  /** 赢单时固定下来的；没赢单 = null */
  实际: (提成算式 & { 比例: 提成比例; 固定于: string }) | null;
  /** 按实际（固定了）或预估分到每个人；组长排第一 */
  每人: (每人一份 & { name: string })[];
  /** 组长、管理员能改分配 */
  能改: boolean;
  /** 只有项目负责人能填项目底价 */
  能填底价: boolean;
  /** 能分给的人：已进组的组员（不含组长） */
  组员: { userId: string; name: string }[];
  /** 存着的分配（编辑框的初值） */
  分配: 分配;
};
