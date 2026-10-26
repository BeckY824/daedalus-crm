/**
 * 企业版导入 · AI 清洗（2026-10-26）：规则认不出的格子交给 AI 补认，回来再按规则校验一遍才落进映射。
 *
 * 只问两样：
 *   - 格式：金额（认金额 认不出）、日期（预计成交 / 结单日期）、跟进时间、国家（不在国家候选里）、来源（不在来源候选里）
 *   - 同一家：本批里名字很像（公司名键相同或互相包含）、电话不同的两家客户是不是同一家
 * 落在 m.格式 / m.同一家，m.说明 记「AI」；清洗（clean.ts）照映射用，人在报告里可以改、可以整块不采用。
 *
 * 隐私：只发格子本身，带 @、像手机号、7 位以上连续数字、超过 40 字的格子一律不发；同一家只发两个公司名。
 * AI 用客户自己的 Key（getLlmConfig），没配 Key 就只走规则。测试不花钱：ENT_IMPORT_AI=mock 或调用方传一个 清洗器。
 * AI 失败只加一条提醒、照规则走，绝不挡导入。
 */
import { 认国家 } from "../customer-extra";
import { 认日期 } from "../import/plan";
import { 查电话, 号键 } from "../phone";
import { 公司名键, 名键, 国家们, 拆, 来源们, 校验格式, 认时间, 认金额 } from "./clean";
import { 格式类们, type 原始记录, type 映射, type 格式类 } from "./types";

/** 每类最多问多少：太多时只问出现最多的那些，剩下的照规则进备注 */
const 每类上限 = 60;
/** 客户多于这个数就不算「互相包含」（两两比太慢），只认公司名键完全相同的 */
const 包含比对上限 = 3000;

export type 清洗输入 = {
  /** 规则认不出的原值，按类给 */
  格式: Partial<Record<格式类, string[]>>;
  /** 国家 / 来源只能从这里挑 */
  国家候选: string[];
  来源候选: string[];
  /** 名字很像、电话不同的客户对：键 `前一家名键|后一家名键` */
  同一家: { 键: string; 前: string; 后: string }[];
};

/** AI 的回答：原值 → 我们的写法（null = 认不出）；键 → 是不是同一家。都是建议，回来还要校验 */
export type 清洗输出 = {
  格式?: Partial<Record<格式类, Record<string, string | null>>>;
  同一家?: Record<string, boolean>;
};

export type 清洗器 = (输入: 清洗输入) => Promise<清洗输出>;

/** 能不能发出去：带 @、像手机号、7 位以上连续数字、超过 40 字的不发 */
export function 能发(v: string): boolean {
  const s = v.trim();
  if (!s || s.length > 40 || s.includes("@")) return false;
  if (/\d{7,}/.test(s)) return false;
  if (/1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}/.test(s)) return false;
  return true;
}


/** 规则就认得出的不用问 */
function 规则认得(类: 格式类, v: string): boolean {
  if (类 === "金额") return 认金额(v) !== null;
  if (类 === "日期") return 认日期(v) !== null;
  if (类 === "时间") return 认时间(v) !== null;
  if (类 === "国家") return 国家们.includes(认国家(v) ?? "");
  return 来源们.includes(v.trim());
}

/** 哪类实体的哪个字段归哪一类 */
const 字段类: [实体: 原始记录["实体"], 字段: string, 类: 格式类][] = [
  ["opportunity", "amount", "金额"],
  ["opportunity", "expectedDealAt", "日期"],
  ["opportunity", "closedAt", "日期"],
  ["followup", "occurredAt", "时间"],
  ["customer", "country", "国家"],
  ["customer", "source", "来源"],
  ["lead", "source", "来源"],
];

/** 找出要问 AI 的：规则认不出、映射里还没有（人改过的、上次问过的都不再问）、能发出去的。按出现次数多的先问 */
export function 找要问的(记录: readonly 原始记录[], m: 映射): 清洗输入 {
  const 次数 = new Map<格式类, Map<string, number>>();
  const 客户: { 名: string; 号: string }[] = [];
  for (const r of 记录) {
    const s = 拆(r, m.列[r.实体] ?? {});
    for (const [e, f, 类] of 字段类) {
      if (r.实体 !== e) continue;
      const v = s.值[f];
      if (!v || 规则认得(类, v) || m.格式?.[类]?.[v] !== undefined || !能发(v)) continue;
      const c = 次数.get(类) ?? new Map<string, number>();
      c.set(v, (c.get(v) ?? 0) + 1);
      次数.set(类, c);
    }
    if (r.实体 === "customer" && s.值.name) {
      const p = s.值.phone ? 查电话(s.值.phone, { 必填: false }) : null;
      客户.push({ 名: s.值.name, 号: p?.ok ? 号键(p.phone) : "" });
    }
  }
  const 格式: 清洗输入["格式"] = {};
  for (const 类 of 格式类们) {
    const c = 次数.get(类);
    if (!c?.size) continue;
    格式[类] = [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 每类上限).map(([v]) => v);
  }
  return { 格式, 国家候选: 国家们, 来源候选: 来源们, 同一家: 找像的(客户, m) };
}

/** 本批里名字很像、电话不同的客户对（前一家在前）。同号的清洗本来就并，名键相同的本来就是同名，都不问 */
function 找像的(客户: { 名: string; 号: string }[], m: 映射): 清洗输入["同一家"] {
  const 见过 = new Set<string>();
  const 首个: { 名: string; 号: string; 名键: string; 公司键: string }[] = [];
  for (const c of 客户) {
    const nk = 名键(c.名);
    if (见过.has(nk)) continue;
    见过.add(nk);
    首个.push({ ...c, 名键: nk, 公司键: 公司名键(c.名) });
  }
  const 包含 = 首个.length <= 包含比对上限;
  const 对: 清洗输入["同一家"] = [];
  for (let i = 0; i < 首个.length && 对.length < 每类上限; i++) {
    const a = 首个[i];
    if (!a.公司键) continue;
    for (let j = i + 1; j < 首个.length && 对.length < 每类上限; j++) {
      const b = 首个[j];
      if (!b.公司键 || (a.号 && a.号 === b.号)) continue;
      const [短, 长] = a.公司键.length <= b.公司键.length ? [a.公司键, b.公司键] : [b.公司键, a.公司键];
      const 像 = 短 === 长 || (包含 && 短.length >= 4 && 长.includes(短));
      if (!像) continue;
      const 键 = `${a.名键}|${b.名键}`;
      if (m.同一家?.[键] !== undefined) continue;
      对.push({ 键, 前: a.名, 后: b.名 });
    }
  }
  return 对;
}

/** 把 AI 的回答校验后落进映射，返回落了几项。只收问过的键；格式按规则再认一遍，认不出的丢掉 */
export function 收清洗建议(m: 映射, out: 清洗输出, 输入: 清洗输入): number {
  let n = 0;
  m.说明 ??= {};
  for (const 类 of 格式类们) {
    const 问了 = new Set(输入.格式[类] ?? []);
    const 回 = out.格式?.[类];
    if (!问了.size || !回 || typeof 回 !== "object") continue;
    for (const [v, 说] of Object.entries(回)) {
      if (!问了.has(v) || typeof 说 !== "string") continue;
      const ok = 校验格式(类, 说);
      if (!ok) continue;
      ((m.格式 ??= {})[类] ??= {})[v] = ok;
      m.说明[格式说明键(类, v)] = "AI";
      n++;
    }
  }
  const 问了对 = new Set(输入.同一家.map((x) => x.键));
  for (const [k, 是] of Object.entries(out.同一家 ?? {})) {
    if (!问了对.has(k) || typeof 是 !== "boolean") continue;
    (m.同一家 ??= {})[k] = 是;
    m.说明[同一家说明键(k)] = "AI";
    n++;
  }
  return n;
}

export const 格式说明键 = (类: 格式类, v: string) => `格式|${类}|${v}`;
export const 同一家说明键 = (k: string) => `同一家|${k}`;

const 提示词 = `你在帮一家公司把老 CRM（飞书 / 钉钉等）导出的数据搬进新 CRM。下面是规则认不出来的几样格子，请逐项给建议。
输入是 JSON：
- 格式.金额：原写法 → 金额数字（单位元，只写数字，比如 "50000"）。
- 格式.日期：原写法 → "YYYY-MM-DD"。
- 格式.时间：原写法 → "YYYY-MM-DD HH:mm"（没写钟点就 "00:00"）。
- 格式.国家：原写法 → 「国家候选」里的一个；格式.来源：原写法 → 「来源候选」里的一个。
- 同一家：两个客户名是不是同一家公司（分公司、简称、中英文名算同一家；同行业不同公司不算）。
认不出、拿不准就写 null（格式）或不写这一项（同一家），绝不猜。
只回 JSON：{"格式":{"金额":{"原写法":"50000"}},"同一家":{"键":true}}。`;

/** 真调 AI（客户自己的 Key）。没配 Key 的情况调用方已经挡掉了 */
export const AI清洗: 清洗器 = async (输入) => {
  const { chatMessagesJSON } = await import("../llm");
  const out = await chatMessagesJSON(
    [
      { role: "system", content: 提示词 },
      { role: "user", content: JSON.stringify(输入) },
    ],
    { maxTokens: 4000, temperature: 0, timeoutMs: 90_000, feature: "import" },
  );
  return (out && typeof out === "object" ? out : {}) as 清洗输出;
};

const 全角 = (s: string) => s.replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/**
 * 模拟模式（ENT_IMPORT_AI=mock）：不联网、不花钱，用来走通「问 AI → 校验 → 落进映射」这条路。
 * 金额「约 5 万」这种去掉前后的字再认；日期 / 时间去掉「左右 / 前后」再认；国家 / 来源找候选里被包含的；
 * 同一家：一个公司名键包含另一个就认是
 */
export const 模拟清洗: 清洗器 = async (输入) => {
  const 格式: 清洗输出["格式"] = {};
  const 去饰 = (v: string) => 全角(v).replace(/^(约|大约|大概|预计|共)/, "").replace(/(左右|上下|前后|以内|多)$/, "").trim();
  for (const v of 输入.格式.金额 ?? []) {
    const n = 认金额(去饰(v));
    (格式.金额 ??= {})[v] = n === null ? null : String(n);
  }
  for (const 类 of ["日期", "时间"] as const) {
    for (const v of 输入.格式[类] ?? []) {
      const s = 去饰(v);
      const d = 类 === "日期" ? 认日期(s) : 认时间(s);
      (格式[类] ??= {})[v] = d ? s : null;
    }
  }
  for (const [类, 候选] of [["国家", 输入.国家候选], ["来源", 输入.来源候选]] as const) {
    for (const v of 输入.格式[类] ?? []) (格式[类] ??= {})[v] = 候选.find((c) => v.includes(c)) ?? null;
  }
  const 同一家: Record<string, boolean> = {};
  for (const x of 输入.同一家) {
    const [a, b] = [公司名键(x.前), 公司名键(x.后)];
    if (a && b && (a.includes(b) || b.includes(a))) 同一家[x.键] = true;
  }
  return { 格式, 同一家 };
};

/** 该用哪个清洗器：传了就用传的；ENT_IMPORT_AI=mock 用模拟；=off 不用；否则看有没有配 Key */
export async function 选清洗器(传入?: 清洗器 | null): Promise<{ 清洗器: 清洗器 | null; 说明: string }> {
  if (传入 !== undefined) return { 清洗器: 传入, 说明: "" };
  const 开关 = process.env.ENT_IMPORT_AI;
  if (开关 === "mock") return { 清洗器: 模拟清洗, 说明: "" };
  if (开关 === "off") return { 清洗器: null, 说明: "" };
  const { getLlmConfig } = await import("../llm-config");
  if (!(await getLlmConfig())) return { 清洗器: null, 说明: "" };
  return { 清洗器: AI清洗, 说明: "" };
}

/**
 * 清洗前问一次 AI，把补认的落进映射（就地改 m）。返回给报告的提醒。没东西可问、没 AI 都不出声（猜映射那步已经说过没配 Key）。
 * 映射里已有的（人改过的、上次问过的）不再问，所以人改的不会被盖掉
 */
export async function AI补清洗(记录: readonly 原始记录[], m: 映射, 传入?: 清洗器 | null): Promise<{ 提醒: string[]; 补了: number }> {
  const 输入 = 找要问的(记录, m);
  const 有要问 = Object.values(输入.格式).some((x) => x?.length) || 输入.同一家.length;
  if (!有要问) return { 提醒: [], 补了: 0 };
  const 选 = await 选清洗器(传入);
  if (!选.清洗器) return { 提醒: [], 补了: 0 };
  try {
    const out = await 选.清洗器(输入);
    const n = 收清洗建议(m, out, 输入);
    return { 提醒: n ? [`AI 清洗补认了 ${n} 格（金额 / 日期 / 国家 / 来源 / 同一家），报告里「AI 清洗」一节可以逐项改或整块不采用`] : [], 补了: n };
  } catch (e) {
    return { 提醒: [`AI 清洗这一步没成功（${e instanceof Error ? e.message.slice(0, 80) : "未知错误"}），认不出的格子照规则放进备注`], 补了: 0 };
  }
}

/** 「不采用」：把 AI 补的格式和同一家拿掉，人改过的留着 */
export function 去掉AI清洗(m: 映射): void {
  const 说明 = m.说明 ?? {};
  for (const 类 of 格式类们) {
    const 表 = m.格式?.[类];
    if (!表) continue;
    for (const v of Object.keys(表)) if (说明[格式说明键(类, v)] === "AI") {
      delete 表[v];
      delete 说明[格式说明键(类, v)];
    }
  }
  for (const k of Object.keys(m.同一家 ?? {})) if (说明[同一家说明键(k)] === "AI") {
    delete m.同一家![k];
    delete 说明[同一家说明键(k)];
  }
}
