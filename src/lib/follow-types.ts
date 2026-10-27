/**
 * 跟进渠道自定义（D-48，2026-10-27）：内置那十种能改名、能藏，老板 / 管理员还能自己加渠道，个数不限。
 *
 * 存在 Setting「followTypes」，和业务配置（business）分开存、分开同步：
 * 管理员能改渠道、改不了业务配置，云端按 key 放行（scope-policy 改设置）；两人同时改一个也不会把另一个盖掉。
 *
 * 存的值不变：内置的照旧是 PHONE、WECHAT…，自定义的是「C_」开头的一串（建了就不变，改名只改显示）。
 * 藏起来、删掉的渠道只是下拉里不再出现，老记录照样按原名显示；认不出的值（别人电脑上新加、这台还没同步到）显示成「其他记录」。
 * 不依赖数据库，客户端也能引。
 */
import { FOLLOW_TYPES } from "./constants";
import { categorical } from "./palette";

export const FOLLOW_TYPES_KEY = "followTypes";

export type 跟进类型 = { value: string; label: string; color: string; icon: string; 自定义?: boolean };
export type 自定义渠道 = { value: string; label: string; hidden?: boolean; deleted?: boolean };
export type FollowTypeConfig = {
  /** 内置类型改的名：PHONE → 「打电话」 */
  rename: Record<string, string>;
  /** 藏起来的内置类型：下拉里不出现，老记录照样显示 */
  hidden: string[];
  /** 自己加的渠道。deleted 的留着，只为老记录还能叫出原名 */
  custom: 自定义渠道[];
};
export const 空跟进配置: FollowTypeConfig = { rename: {}, hidden: [], custom: [] };
/** 下面的函数都收可空的配置：老代码、单测里手拼的业务配置没有 followTypes，就当一项没改 */
type 配置 = FollowTypeConfig | null | undefined;

/** 渠道名最长几个字：会出现在下拉、表格的「类型」列和统计图例里 */
export const 渠道名上限 = 12;
/** 自定义渠道最多几个：「个数不限」是业务上的说法，这里只防误操作把配置撑爆 */
export const 自定义上限 = 100;

const 内置值 = new Set<string>(FOLLOW_TYPES.map((t) => t.value));
/** 不是渠道、是计划和提醒用的两种：只读场景、首条跟进、完成计划弹窗不给选 */
export const 非渠道 = new Set(["TASK", "REMIND"]);
/** 自定义渠道图标轮流用的颜色（必须是真 hex：FollowUpsView 会拼透明度后缀） */
const 轮流色 = [categorical.blue, categorical.green, categorical.violet, categorical.pink, categorical.cyan, categorical.orange, categorical.teal, categorical.lime, categorical.yellow, categorical.amber];

const 名 = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, 渠道名上限) : "");
export const 是自定义值 = (v: string) => /^C_[A-Za-z0-9]{4,24}$/.test(v);

/** 库里读出来的、表单传上来的、同步过来的，一律先过一遍：坏的丢掉、重复的留第一个 */
export function mergeFollowTypes(raw: unknown): FollowTypeConfig {
  const o = raw && typeof raw === "object" ? (raw as Partial<Record<keyof FollowTypeConfig, unknown>>) : {};
  const rename: Record<string, string> = {};
  if (o.rename && typeof o.rename === "object") {
    for (const [k, v] of Object.entries(o.rename as Record<string, unknown>)) {
      const n = 名(v);
      if (内置值.has(k) && n && n !== FOLLOW_TYPES.find((t) => t.value === k)?.label) rename[k] = n;
    }
  }
  const hidden = Array.isArray(o.hidden) ? [...new Set(o.hidden.filter((v): v is string => typeof v === "string" && 内置值.has(v)))] : [];
  const custom: 自定义渠道[] = [];
  const 见过 = new Set<string>();
  for (const c of Array.isArray(o.custom) ? o.custom : []) {
    if (!c || typeof c !== "object") continue;
    const { value, label, hidden: h, deleted } = c as Record<string, unknown>;
    const n = 名(label);
    if (typeof value !== "string" || !是自定义值(value) || !n || 见过.has(value)) continue;
    见过.add(value);
    custom.push({ value, label: n, ...(h === true ? { hidden: true } : {}), ...(deleted === true ? { deleted: true } : {}) });
    if (custom.length >= 自定义上限 * 2) break;
  }
  return { rename, hidden, custom };
}

/** 新渠道的值：建了就不变，改名只改 label */
export function 新渠道值(已有: readonly string[] = []): string {
  for (;;) {
    const v = `C_${Math.random().toString(36).slice(2, 10).padEnd(8, "0")}`;
    if (!已有.includes(v)) return v;
  }
}

function 内置元(cfg: FollowTypeConfig, t: (typeof FOLLOW_TYPES)[number]): 跟进类型 {
  return { value: t.value, label: cfg.rename[t.value] || t.label, color: t.color, icon: t.icon };
}
function 自定义元(c: 自定义渠道, i: number): 跟进类型 {
  return { value: c.value, label: c.label, color: 轮流色[i % 轮流色.length], icon: "tag", 自定义: true };
}

/**
 * 全部认得的类型（藏起来、删掉的也在）：取名、取图标、反查用。
 * 顺序 = 下拉里的顺序：内置渠道 → 自定义渠道 → 跟进任务、跟进提醒、其他记录。外贸模版把 WhatsApp 提到最前（只改顺序，存的值不变）
 */
export function 全部跟进类型(c?: 配置, 外贸 = false): 跟进类型[] {
  const cfg = c ?? 空跟进配置;
  const 内置 = FOLLOW_TYPES.map((t) => 内置元(cfg, t));
  const 前 = 内置.filter((t) => !非渠道.has(t.value) && t.value !== "OTHER");
  const 后 = 内置.filter((t) => 非渠道.has(t.value) || t.value === "OTHER");
  const 排 = 外贸 ? [...前.filter((t) => t.value === "WHATSAPP"), ...前.filter((t) => t.value !== "WHATSAPP")] : 前;
  return [...排, ...cfg.custom.map(自定义元), ...后];
}

/** 下拉里能选的：去掉藏起来、删掉的 */
export function 跟进类型表(c?: 配置, 外贸 = false, o: { 只渠道?: boolean } = {}): 跟进类型[] {
  const cfg = c ?? 空跟进配置;
  const 藏 = new Set([...cfg.hidden, ...cfg.custom.filter((c) => c.hidden || c.deleted).map((c) => c.value)]);
  return 全部跟进类型(cfg, 外贸).filter((t) => !藏.has(t.value) && !(o.只渠道 && 非渠道.has(t.value)));
}

/** 取一个值的名字、颜色、图标。认不出的（别人新加、这台还没同步到）按「其他记录」显示 */
export function 跟进类型元(cfg: 配置, v: string | null | undefined): 跟进类型 {
  const all = 全部跟进类型(cfg);
  return all.find((t) => t.value === v) ?? all.find((t) => t.value === "OTHER")!;
}
export const 跟进类型名 = (cfg: 配置, v: string | null | undefined) => 跟进类型元(cfg, v).label;

/** 存得进库的值：认得的都行，藏了、删了的也行——老记录只改内容不改类型时照样能存；新记录下拉里本来就选不到它们 */
export function 合法跟进类型(cfg: 配置, v: unknown): v is string {
  if (typeof v !== "string") return false;
  return 内置值.has(v) || (cfg?.custom ?? []).some((c) => c.value === v);
}

/**
 * 名字或值 → 值（AI 记跟进、导入映射、手机端）。认改过的名、也认内置原名和英文值；
 * 只认能选的（藏了、删了的不往新记录上落），认不出回 null
 */
export function 跟进类型值(cfg: 配置, s: unknown): string | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const x = s.trim();
  const 能选 = 跟进类型表(cfg);
  const 内置原名 = (t: 跟进类型) => FOLLOW_TYPES.find((b) => b.value === t.value)?.label;
  return (
    能选.find((t) => t.value === x || t.value === x.toUpperCase())?.value ??
    能选.find((t) => t.label === x)?.value ??
    能选.find((t) => 内置原名(t) === x)?.value ??
    能选.find((t) => t.label.toLowerCase() === x.toLowerCase())?.value ??
    null
  );
}

/** 保存前的检查：名字不能重、至少留一个能选的渠道 */
export function 跟进配置问题(cfg: FollowTypeConfig): string | null {
  const 能选 = 跟进类型表(cfg, false, { 只渠道: true });
  if (!能选.length) return "至少留一个能选的渠道";
  if (cfg.custom.filter((c) => !c.deleted).length > 自定义上限) return `自定义渠道最多 ${自定义上限} 个`;
  const 名们 = 全部跟进类型(cfg).filter((t) => !cfg.custom.some((c) => c.value === t.value && c.deleted)).map((t) => t.label);
  const 重 = 名们.find((n, i) => 名们.indexOf(n) !== i);
  return 重 ? `渠道名「${重}」重复了` : null;
}
