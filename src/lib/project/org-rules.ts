/**
 * 企业版的组织规则（2026-10-24）：项目公海持有上限、超时回收、节点必填等。每条规则都是开关，默认全关——
 * 通用的 20–30 人 B2B 团队不开也照旧用；要的团队老板在「设置 → 项目模式」里自己打开。
 * 存在 Setting 的 orgRules 一个 key 里（业务配置 getBusiness 会丢掉不认识的 key，不混进去）。
 * 这里只管规整，界面也引（不能碰 prisma）；读写库在 org-rules-store.ts，规矩在 lib/project/db.ts 里用
 */
import { 节点们, 阶段们 } from "./nodes";
import { 出口叫法上限, type 出口叫法改动 } from "./stage-dict";
import { 必填项名们, 能配必填的节点 } from "./required";

/** 持有上限最多填多少：防手滑多打几个 0 */
export const 上限最大 = 999;
/** 节点处理时长最多填多少天 */
export const 时长最大 = 365;
/** 能设处理时长的节点：线索、商机阶段的；订单阶段永远不回收 */
export const 能设时长的节点: readonly string[] = [...节点们.线索, ...节点们.商机];

/**
 * 往前推节点谁能推（企业版，10-26 决定 #18）：
 *   - 负责人可推（默认）：负责人本人、直属上级、老板、总管理员都能往前推
 *   - 仅上级推：负责人有直属上级时只给直属上级、老板、总管理员（D-37 原来那套）
 * 往后退、点结局不归这条管；跨阶段单向、出口有限照旧。跟「按组织架构看客户」开关走（lib/project/db.ts 直属才推）
 */
export const 推进权限们 = ["负责人可推", "仅上级推"] as const;
export type 推进权限 = (typeof 推进权限们)[number];

export type 组织规则 = {
  公海: {
    /** 开了才算持有上限；关着时谁都能领、能指派，不限个数 */
    持有上限开: boolean;
    /** 没单独设的人用这个 */
    默认上限: number;
    /** 按人单独设（userId → 个数），0 = 这个人不能再多拿 */
    每人上限: Record<string, number>;
  };
  超时回收: {
    /** 开了才回收；关着时节点时长存着不用，项目沟通也不强制填下一步时间 */
    开: boolean;
    /** 节点名 → 最长处理天数；没设的节点不回收 */
    节点天数: Record<string, number>;
  };
  节点推进: {
    /** 开了、节点配了必填才按必填自动推进（lib/project/required.ts）；关着时配的清单存着不用 */
    开: boolean;
    /** 节点名 → 必填哪几样（required.ts 的 必填项们）；没配的节点照原来手动推 */
    必填: Record<string, string[]>;
  };
  阶段: {
    /** 往前推节点谁能推，见 推进权限们 */
    推进权限: 推进权限;
    /** 每个阶段两个出口的叫法 [走成, 没走成]，null = 用字典里的（stage-dict.ts 字典of 合上）；只换说法，存的结局不变 */
    出口叫法: 出口叫法改动;
  };
};

export const 默认组织规则: 组织规则 = {
  公海: { 持有上限开: false, 默认上限: 30, 每人上限: {} },
  超时回收: { 开: false, 节点天数: {} },
  节点推进: { 开: false, 必填: {} },
  阶段: { 推进权限: "负责人可推", 出口叫法: {} },
};

/** 规整一个出口叫法：去空格，空的 = null；太长 / 不是字串返回 undefined（读的时候丢掉，改的时候报错） */
function 一个叫法(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return null;
  return t.length > 出口叫法上限 ? undefined : t;
}

/** 出口叫法整份规整：每个阶段两个都空就不留；坏的 → error（读的时候忽略那个阶段） */
function 规整出口叫法(raw: unknown): 出口叫法改动 | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "出口叫法格式不对，刷新再试" };
  const 出: Record<string, [string | null, string | null]> = {};
  for (const [s, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(阶段们 as readonly string[]).includes(s)) return { error: `没有「${s}」这个阶段` };
    if (v === null || v === undefined) continue;
    if (!Array.isArray(v) || v.length !== 2) return { error: "出口叫法格式不对，刷新再试" };
    const 成 = 一个叫法(v[0]), 没成 = 一个叫法(v[1]);
    if (成 === undefined || 没成 === undefined) return { error: `${s}阶段的出口叫法请填 1–${出口叫法上限} 个字` };
    if (成 && 成 === 没成) return { error: `${s}阶段两个出口不能叫一样的名字` };
    if (成 || 没成) 出[s] = [成, 没成];
  }
  return 出;
}

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
  const 超时 = (r.超时回收 && typeof r.超时回收 === "object" ? r.超时回收 : {}) as Record<string, unknown>;
  const 天数: Record<string, number> = {};
  if (超时.节点天数 && typeof 超时.节点天数 === "object") {
    for (const [node, v] of Object.entries(超时.节点天数 as Record<string, unknown>)) {
      const n = 整数(v, 1, 时长最大);
      if (能设时长的节点.includes(node) && n !== null) 天数[node] = n;
    }
  }
  const 推进 = (r.节点推进 && typeof r.节点推进 === "object" ? r.节点推进 : {}) as Record<string, unknown>;
  const 必填: Record<string, string[]> = {};
  if (推进.必填 && typeof 推进.必填 === "object") {
    for (const [node, v] of Object.entries(推进.必填 as Record<string, unknown>)) {
      if (!能配必填的节点.includes(node) || !Array.isArray(v)) continue;
      const 项 = [...new Set(v.filter((x): x is string => typeof x === "string" && 必填项名们.includes(x)))];
      if (项.length) 必填[node] = 项;
    }
  }
  return {
    公海: {
      持有上限开: 公海.持有上限开 === true,
      默认上限: 整数(公海.默认上限, 1, 上限最大) ?? 默认组织规则.公海.默认上限,
      每人上限: 每人,
    },
    超时回收: { 开: 超时.开 === true, 节点天数: 天数 },
    节点推进: { 开: 推进.开 === true, 必填 },
    阶段: 规整阶段块(r.阶段),
  };
}

function 规整阶段块(raw: unknown): 组织规则["阶段"] {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const 叫法: Record<string, readonly [string | null, string | null]> = {};
  if (a.出口叫法 && typeof a.出口叫法 === "object") {
    // 一个阶段一个阶段过：坏了的那个阶段丢掉，别的照留
    for (const [s, v] of Object.entries(a.出口叫法 as Record<string, unknown>)) {
      const r = 规整出口叫法({ [s]: v });
      if (!("error" in r) && r[s as keyof 出口叫法改动]) 叫法[s] = r[s as keyof 出口叫法改动]!;
    }
  }
  return {
    推进权限: (推进权限们 as readonly unknown[]).includes(a.推进权限) ? (a.推进权限 as 推进权限) : 默认组织规则.阶段.推进权限,
    出口叫法: 叫法,
  };
}

export type 规则改动 = {
  /** 每人上限里传 null = 这个人不单独设了 */
  公海?: Partial<Omit<组织规则["公海"], "每人上限">> & { 每人上限?: Record<string, number | null> };
  /** 节点天数整份替换（界面每次带全），传 null / 空的节点 = 不设、不回收 */
  超时回收?: { 开?: boolean; 节点天数?: Record<string, number | string | null> };
  /** 必填整份替换（界面每次带全），传 null / 空的节点 = 不配、照原来手动推 */
  节点推进?: { 开?: boolean; 必填?: Record<string, string[] | null> };
  /** 出口叫法整份替换（界面每次带全） */
  阶段?: { 推进权限?: 推进权限; 出口叫法?: Record<string, readonly [string | null, string | null] | null> };
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
  const 超时回收 = { ...现在.超时回收 };
  if (改.超时回收 !== undefined) {
    const t = 改.超时回收;
    if (!t || typeof t !== "object") return { error: "要改什么？" };
    if (t.开 !== undefined) {
      if (typeof t.开 !== "boolean") return { error: "超时回收开关只能开或关" };
      超时回收.开 = t.开;
    }
    if (t.节点天数 !== undefined) {
      if (!t.节点天数 || typeof t.节点天数 !== "object") return { error: "节点时长格式不对，刷新再试" };
      const 天数: Record<string, number> = {};
      for (const [node, v] of Object.entries(t.节点天数 as Record<string, unknown>)) {
        if (!能设时长的节点.includes(node)) return { error: `「${node}」不是线索、商机阶段的节点，不能设处理时长` };
        if (v === null || v === undefined || v === "") continue;
        const n = 整数(v, 1, 时长最大);
        if (n === null) return { error: `「${node}」的处理时长请填 1–${时长最大} 的整数（天）` };
        天数[node] = n;
      }
      超时回收.节点天数 = 天数;
    }
  }
  const 节点推进 = { ...现在.节点推进 };
  if (改.节点推进 !== undefined) {
    const t = 改.节点推进;
    if (!t || typeof t !== "object") return { error: "要改什么？" };
    if (t.开 !== undefined) {
      if (typeof t.开 !== "boolean") return { error: "节点推进开关只能开或关" };
      节点推进.开 = t.开;
    }
    if (t.必填 !== undefined) {
      if (!t.必填 || typeof t.必填 !== "object") return { error: "必填清单格式不对，刷新再试" };
      const 必填: Record<string, string[]> = {};
      for (const [node, v] of Object.entries(t.必填 as Record<string, unknown>)) {
        if (!能配必填的节点.includes(node)) {
          return { error: [...节点们.线索, ...节点们.商机, ...节点们.订单].includes(node) ? `「${node}」不能配必填（最后一个节点由人点成功交付）` : `「${node}」不是项目节点，刷新再试` };
        }
        if (v === null || v === undefined) continue;
        if (!Array.isArray(v)) return { error: "必填清单格式不对，刷新再试" };
        const 坏 = v.find((x) => typeof x !== "string" || !必填项名们.includes(x));
        if (坏 !== undefined) return { error: `「${String(坏)}」不是能选的必填项，刷新再试` };
        const 项 = [...new Set(v as string[])];
        if (项.length) 必填[node] = 项;
      }
      节点推进.必填 = 必填;
    }
  }
  const 阶段 = { ...现在.阶段 };
  if (改.阶段 !== undefined) {
    const a = 改.阶段;
    if (!a || typeof a !== "object") return { error: "要改什么？" };
    if (a.推进权限 !== undefined) {
      if (!(推进权限们 as readonly unknown[]).includes(a.推进权限)) return { error: `往前推权限只能选${推进权限们.join("或")}` };
      阶段.推进权限 = a.推进权限;
    }
    if (a.出口叫法 !== undefined) {
      const r = 规整出口叫法(a.出口叫法);
      if ("error" in r) return r;
      阶段.出口叫法 = r;
    }
  }
  return { ...现在, 公海, 超时回收, 节点推进, 阶段 };
}

/** 负责人本人能不能往前推（推进权限，lib/project/db.ts 往前推不给 用） */
export function 负责人可推(规则: 组织规则): boolean {
  return 规则.阶段.推进权限 === "负责人可推";
}

/** 这个人的持有上限；没开上限 = null（不限） */
export function 持有上限of(规则: 组织规则, userId: string): number | null {
  if (!规则.公海.持有上限开) return null;
  return 规则.公海.每人上限[userId] ?? 规则.公海.默认上限;
}
