/**
 * 企业版卡点（2026-10-26）的取值规矩：类型、影响等级、阻碍主体、解决时限的默认，编号格式，沟通记录的时限提醒。
 * 只管规整，界面也引（不能碰 prisma）；读写库、谁能动在 lib/project/blocker.ts。
 * 管理员的默认存在 Setting 的 entBlockerDefaults 一个 key 里
 */
import { dayjs } from "../utils";

export const 卡点类型们 = ["暂无卡点", "轻度卡点", "中度卡点", "重要卡点"] as const;
export const 影响等级们 = ["短期不影响", "项目暂停", "项目终止", "可能丢单"] as const;
/** 看板 = 谁都没接（发布没指认、被返回的）；待接受 = 指认 / 转让给了谁、等他点接受；处理中；已解决 */
export const 卡点状态们 = ["看板", "待接受", "处理中", "已解决"] as const;
export type 卡点类型 = (typeof 卡点类型们)[number];
export type 影响等级 = (typeof 影响等级们)[number];
export type 卡点状态 = (typeof 卡点状态们)[number];

export const 描述上限 = 500;
export const 理由上限 = 200;
export const 时限最大 = 365;
export const 主体名上限 = 20;
export const 主体最多 = 20;

export type 卡点默认 = {
  /** 卡点类型 → 解决时限（天），发布时没填就按这个 */
  时限天数: Record<卡点类型, number>;
  /** 阻碍主体的选项（单选） */
  阻碍主体们: string[];
  默认类型: 卡点类型;
  默认影响: 影响等级;
};

export const 默认卡点默认: 卡点默认 = {
  时限天数: { 暂无卡点: 7, 轻度卡点: 7, 中度卡点: 3, 重要卡点: 1 },
  阻碍主体们: ["客户", "技术", "价格", "竞品", "内部资源", "其他"],
  默认类型: "中度卡点",
  默认影响: "短期不影响",
};

function 整数(v: unknown, 最小: number, 最大: number): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 最小 && n <= 最大 ? n : null;
}
const 是类型 = (v: unknown): v is 卡点类型 => (卡点类型们 as readonly unknown[]).includes(v);
const 是影响 = (v: unknown): v is 影响等级 => (影响等级们 as readonly unknown[]).includes(v);

function 主体清单(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const 们 = [...new Set(v.map((x) => (typeof x === "string" ? x.trim() : "")).filter((x) => x && x.length <= 主体名上限))].slice(0, 主体最多);
  return 们.length ? 们 : null;
}

/** 存着的（或界面传来的）规整成完整的一份：缺的、坏的退回默认 */
export function 规整卡点默认(raw: unknown): 卡点默认 {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const 天 = (r.时限天数 && typeof r.时限天数 === "object" ? r.时限天数 : {}) as Record<string, unknown>;
  const 时限天数 = { ...默认卡点默认.时限天数 };
  for (const t of 卡点类型们) {
    const n = 整数(天[t], 1, 时限最大);
    if (n !== null) 时限天数[t] = n;
  }
  return {
    时限天数,
    阻碍主体们: 主体清单(r.阻碍主体们) ?? [...默认卡点默认.阻碍主体们],
    默认类型: 是类型(r.默认类型) ? r.默认类型 : 默认卡点默认.默认类型,
    默认影响: 是影响(r.默认影响) ? r.默认影响 : 默认卡点默认.默认影响,
  };
}

/** 管理员改默认：坏的报错（不悄悄退回默认），好的合上旧的 */
export function 合上卡点默认(旧: 卡点默认, patch: unknown): 卡点默认 | { error: string } {
  if (!patch || typeof patch !== "object") return { error: "要改什么？" };
  const p = patch as Record<string, unknown>;
  const 新 = { ...旧, 时限天数: { ...旧.时限天数 } };
  if (p.时限天数 !== undefined) {
    if (!p.时限天数 || typeof p.时限天数 !== "object") return { error: "解决时限要按卡点类型填天数" };
    for (const [t, v] of Object.entries(p.时限天数 as Record<string, unknown>)) {
      if (!是类型(t)) return { error: `没有「${t}」这种卡点类型` };
      const n = 整数(v, 1, 时限最大);
      if (n === null) return { error: `「${t}」的解决时限要填 1–${时限最大} 天` };
      新.时限天数[t] = n;
    }
  }
  if (p.阻碍主体们 !== undefined) {
    const 们 = 主体清单(p.阻碍主体们);
    if (!们) return { error: `阻碍主体至少留一个，每个不超过 ${主体名上限} 个字` };
    新.阻碍主体们 = 们;
  }
  if (p.默认类型 !== undefined) {
    if (!是类型(p.默认类型)) return { error: "默认卡点类型不对" };
    新.默认类型 = p.默认类型;
  }
  if (p.默认影响 !== undefined) {
    if (!是影响(p.默认影响)) return { error: "默认影响等级不对" };
    新.默认影响 = p.默认影响;
  }
  return 新;
}

export type 发布输入 = {
  type?: unknown; impact?: unknown; obstacle?: unknown; description?: unknown; dueDays?: unknown; resourceRequest?: unknown;
};
export type 好的发布 = { type: 卡点类型; impact: 影响等级; obstacle: string; description: string; dueDays: number; resourceRequest: string | null };

const 文字 = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** 发布卡点填的：类型、影响没填按默认；阻碍主体单选、得在选项里；描述必填；时限没填按类型的默认天数 */
export function 规整发布(input: 发布输入, 默认: 卡点默认): 好的发布 | { error: string } {
  if (!input || typeof input !== "object") return { error: "要发布什么卡点？" };
  const type = input.type === undefined || input.type === "" ? 默认.默认类型 : input.type;
  if (!是类型(type)) return { error: "卡点类型不对" };
  const impact = input.impact === undefined || input.impact === "" ? 默认.默认影响 : input.impact;
  if (!是影响(impact)) return { error: "影响等级不对" };
  const obstacle = 文字(input.obstacle);
  if (!obstacle) return { error: "选一个阻碍主体" };
  if (!默认.阻碍主体们.includes(obstacle)) return { error: `没有「${obstacle}」这个阻碍主体，刷新看看` };
  const description = 文字(input.description);
  if (!description) return { error: "写一句卡在哪" };
  if (description.length > 描述上限) return { error: `描述不超过 ${描述上限} 个字` };
  const dueDays = input.dueDays === undefined || input.dueDays === "" || input.dueDays === null ? 默认.时限天数[type] : 整数(input.dueDays, 1, 时限最大);
  if (dueDays === null) return { error: `解决时限填 1–${时限最大} 天` };
  const 资源 = 文字(input.resourceRequest);
  if (资源.length > 描述上限) return { error: `资源申请不超过 ${描述上限} 个字` };
  return { type, impact, obstacle, description, dueDays, resourceRequest: 资源 || null };
}

/** 一段可选的文字（进度、资源申请、解决方案…）：空 = null，超长报错 */
export function 规整文字(v: unknown, 叫法: string, 必填 = false): string | null | { error: string } {
  const s = 文字(v);
  if (!s) return 必填 ? { error: `${叫法}要填` } : null;
  if (s.length > 描述上限) return { error: `${叫法}不超过 ${描述上限} 个字` };
  return s;
}

/** 编号：前缀 + yyyyMMdd + 当天流水（卡点 BLK 3 位，沟通记录 FUL 6 位） */
export const 卡点编号前缀 = "BLK";
export const 沟通编号前缀 = "FUL";
export function 编号日(now: Date): string {
  return dayjs(now).format("YYYYMMDD");
}
export function 拼编号(前缀: string, now: Date, 流水: number, 位数: number): string {
  return `${前缀}${编号日(now)}${String(流水).padStart(位数, "0")}`;
}
/** 当天最大的编号 → 下一个流水；没有 = 1 */
export function 下一个流水(当天最大: string | null | undefined, 前缀: string, now: Date): number {
  const 头 = `${前缀}${编号日(now)}`;
  if (!当天最大 || !当天最大.startsWith(头)) return 1;
  const n = Number(当天最大.slice(头.length));
  return Number.isInteger(n) ? n + 1 : 1;
}

/**
 * 沟通记录的时限提醒（按下一步时间）：没填、或还没到 → 步步为营；过了 3 天以内 → 卡点大师；再久 → 超出时限
 */
export type 时限提醒 = { 级别: "稳" | "拿捏" | "超时"; 文字: string };
export function 时限提醒of(nextAt: Date | null | undefined, now: Date = new Date()): 时限提醒 {
  if (!nextAt || now.getTime() <= nextAt.getTime()) return { 级别: "稳", 文字: "步步为营 指定能赢" };
  if (now.getTime() - nextAt.getTime() <= 3 * 24 * 3600_000) return { 级别: "拿捏", 文字: "卡点大师 节奏拿捏" };
  return { 级别: "超时", 文字: "超出时限 必须调整" };
}

/** 卡点流转那一行给人看的叫法 */
export const 动作叫法: Record<string, string> = {
  publish: "发布", assign: "指认", claim: "认领", accept: "接受", transfer: "转让", return: "返回看板",
  resolve: "解决", progress: "改进度", handover: "离职交接",
};
