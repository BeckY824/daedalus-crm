/**
 * 企业版的组织规则（2026-10-24）：项目公海持有上限等。每条规则都是开关，默认全关——
 * 通用的 20–30 人 B2B 团队不开也照旧用；要的团队老板在「设置 → 项目模式」里自己打开。
 * 存在 Setting 的 orgRules 一个 key 里（业务配置 getBusiness 会丢掉不认识的 key，不混进去）。
 * 这里只管规整，界面也引（不能碰 prisma）；读写库在 org-rules-store.ts，规矩在 lib/project/db.ts 里用
 */
/** 持有上限最多填多少：防手滑多打几个 0 */
export const 上限最大 = 999;

export type 组织规则 = {
  公海: {
    /** 开了才算持有上限；关着时谁都能领、能指派，不限个数 */
    持有上限开: boolean;
    /** 没单独设的人用这个 */
    默认上限: number;
    /** 按人单独设（userId → 个数），0 = 这个人不能再多拿 */
    每人上限: Record<string, number>;
  };
};

export const 默认组织规则: 组织规则 = {
  公海: { 持有上限开: false, 默认上限: 30, 每人上限: {} },
};

function 整数(v: unknown, 最小: number, 最大: number): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 最小 || n > 最大) return null;
  return n;
}

/**
 * 把存着的（或界面传来的）规整成完整的一份：缺的、坏的、超出范围的都退回默认，不认识的 key 丢掉。
 * 读的时候用它兜底，写之前用 规整改动 报错
 */
export function 规整组织规则(raw: unknown): 组织规则 {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const 公海 = (r.公海 && typeof r.公海 === "object" ? r.公海 : {}) as Record<string, unknown>;
  const 每人: Record<string, number> = {};
  if (公海.每人上限 && typeof 公海.每人上限 === "object") {
    for (const [uid, v] of Object.entries(公海.每人上限 as Record<string, unknown>)) {
      const n = 整数(v, 0, 上限最大);
      if (uid && n !== null) 每人[uid] = n;
    }
  }
  return {
    公海: {
      持有上限开: 公海.持有上限开 === true,
      默认上限: 整数(公海.默认上限, 1, 上限最大) ?? 默认组织规则.公海.默认上限,
      每人上限: 每人,
    },
  };
}

export type 规则改动 = {
  /** 每人上限里传 null = 这个人不单独设了 */
  公海?: Partial<Omit<组织规则["公海"], "每人上限">> & { 每人上限?: Record<string, number | null> };
};

/**
 * 老板在界面上改了一部分：先挑出填错的报出来（不偷偷改成默认），再合到现在的那份上。
 * 每人上限整份替换（界面每次带全），传 null 的人 = 删掉单独设置、回到默认
 */
export function 合上改动(现在: 组织规则, 改: 规则改动): 组织规则 | { error: string } {
  if (!改 || typeof 改 !== "object") return { error: "要改什么？" };
  const 公海 = { ...现在.公海 };
  if (改.公海 !== undefined) {
    const g = 改.公海;
    if (!g || typeof g !== "object") return { error: "要改什么？" };
    if (g.持有上限开 !== undefined) {
      if (typeof g.持有上限开 !== "boolean") return { error: "持有上限开关只能开或关" };
      公海.持有上限开 = g.持有上限开;
    }
    if (g.默认上限 !== undefined) {
      const n = 整数(g.默认上限, 1, 上限最大);
      if (n === null) return { error: `默认持有上限请填 1–${上限最大} 的整数` };
      公海.默认上限 = n;
    }
    if (g.每人上限 !== undefined) {
      if (!g.每人上限 || typeof g.每人上限 !== "object") return { error: "单独设的上限格式不对，刷新再试" };
      const 每人: Record<string, number> = {};
      for (const [uid, v] of Object.entries(g.每人上限 as Record<string, unknown>)) {
        if (v === null || v === undefined || v === "") continue;
        const n = 整数(v, 0, 上限最大);
        if (n === null) return { error: `单独设的上限请填 0–${上限最大} 的整数` };
        每人[uid] = n;
      }
      公海.每人上限 = 每人;
    }
  }
  return { ...现在, 公海 };
}

/** 这个人的持有上限；没开上限 = null（不限） */
export function 持有上限of(规则: 组织规则, userId: string): number | null {
  if (!规则.公海.持有上限开) return null;
  return 规则.公海.每人上限[userId] ?? 规则.公海.默认上限;
}
