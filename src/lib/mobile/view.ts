/**
 * 手机库里的行 → 界面要的样子（2026-10-15）。纯函数，不碰存储、不碰网络（tests/mobile-view.test.ts）。
 *
 * 库里的值有两种来路：电脑同步来的（SQLite 里的原样：时间是毫秒数、布尔是 0/1）和手机自己记的（毫秒数、true/false）。
 * 这里统一读法：时间 → 毫秒，布尔 → true/false。
 */
import type { 记录 } from "./sync";
import { 行键 } from "@/lib/sync/scope-policy";

export const 毫秒 = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const n = Number(v);
  if (Number.isFinite(n) && /^\d+$/.test(String(v))) return n;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};
export const 真 = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
const 字 = (v: unknown) => (v == null ? "" : String(v));

export type 跟进视图 = { id: string; type: string; content: string; at: number; by: string; 我记的: boolean; 待同步: boolean };
export type 计划视图 = { id: string; subject: string; at: number; method: string; ownerId: string };
export type 联系人视图 = { id: string; name: string; title: string; phone: string; email: string; wechat: string; 主要: boolean };
export type 商机视图 = { id: string; name: string; stage: string; amount: number; currency: string };
export type 客户视图 = {
  id: string; name: string; phone: string; country: string; whatsapp: string; email: string; wechat: string;
  status: string; 公海: boolean; salesOwnerId: string; 负责人: string; remark: string;
  上次跟进: number | null; 联系人: 联系人视图[]; 商机: 商机视图 | null; 计划: 计划视图 | null; 跟进: 跟进视图[];
};

/**
 * 「我的」页显示的名字（2026-10-15）：优先团队库里自己那行 User 的名字——电脑上改了名，同步过来就跟着变；
 * 还没同步到那一行（刚连上）才用登录时云端给的账号名。行们 = 手机库的 行（键是 行键：表 + 主键）
 */
export function 我的名字(行们: ReadonlyMap<string, 记录>, 我: string, 账号名: string): string {
  const 行 = 我 ? 行们.get(行键("User", 我)) : undefined;
  return 字(行?.r.name).trim() || 账号名;
}

/** 按表把行分好（一次遍历），后面各页都从这里取 */
export function 分表(行们: Iterable<记录>) {
  const 表 = new Map<string, Record<string, unknown>[]>();
  for (const x of 行们) { const a = 表.get(x.t); if (a) a.push(x.r); else 表.set(x.t, [x.r]); }
  return (t: string) => 表.get(t) ?? [];
}

/** 全部客户的视图。我 = 本人在团队库里的 id；待同步 = 还没推上去的跟进 id */
export function 客户们(取: ReturnType<typeof 分表>, 我: string, 待同步: Set<string>): 客户视图[] {
  const 人名 = new Map(取("User").map((u) => [字(u.id), 字(u.name)]));
  const 额外 = new Map(取("CustomerExtra").map((x) => [字(x.customerId), x]));
  const 公海 = new Set(取("CustomerPool").map((x) => 字(x.customerId)));
  const 币 = new Map(取("OpportunityMoney").map((x) => [字(x.opportunityId), 字(x.currency)]));
  const 按客户 = <T>(rows: Record<string, unknown>[], f: (r: Record<string, unknown>) => T) => {
    const m = new Map<string, T[]>();
    for (const r of rows) { const k = 字(r.customerId); const a = m.get(k); const v = f(r); if (a) a.push(v); else m.set(k, [v]); }
    return m;
  };
  const 跟进 = 按客户(取("FollowUp"), (r): 跟进视图 => ({
    id: 字(r.id), type: 字(r.type), content: 字(r.content), at: 毫秒(r.occurredAt) ?? 0,
    by: 字(r.ownerId) === 我 ? "我" : 人名.get(字(r.ownerId)) || "同事", 我记的: 字(r.ownerId) === 我, 待同步: 待同步.has(字(r.id)),
  }));
  const 计划 = 按客户(取("FollowPlan").filter((r) => !真(r.done)), (r): 计划视图 => ({ id: 字(r.id), subject: 字(r.subject), at: 毫秒(r.plannedAt) ?? 0, method: 字(r.method), ownerId: 字(r.ownerId) }));
  const 联系人 = 按客户(取("Contact"), (r): 联系人视图 => ({ id: 字(r.id), name: 字(r.name), title: 字(r.position), phone: 字(r.phone), email: 字(r.email), wechat: 字(r.wechat), 主要: 真(r.isPrimary) }));
  const 商机 = 按客户(取("Opportunity").filter((r) => 字(r.status) === "OPEN" || !r.status), (r) => ({
    v: { id: 字(r.id), name: 字(r.name), stage: 字(r.stage), amount: Number(r.amount) || 0, currency: 币.get(字(r.id)) || "CNY" } as 商机视图,
    at: 毫秒(r.activityAt) ?? 毫秒(r.updatedAt) ?? 0,
  }));
  return 取("Customer").map((c) => {
    const id = 字(c.id), x = 额外.get(id) ?? {};
    const 跟 = (跟进.get(id) ?? []).sort((a, b) => b.at - a.at);
    // 下次跟进：没完成的里面最早的那条（我的优先——老板看得到所有人的计划，排在前面的该是自己的）
    const 计 = (计划.get(id) ?? []).sort((a, b) => (a.ownerId === 我 ? 0 : 1) - (b.ownerId === 我 ? 0 : 1) || a.at - b.at)[0] ?? null;
    const 机 = (商机.get(id) ?? []).sort((a, b) => b.at - a.at)[0]?.v ?? null;
    return {
      id, name: 字(c.name), phone: 字(c.phone), country: 字(x.country), whatsapp: 字(x.whatsapp), email: 字(x.email), wechat: 字(x.wechat),
      status: 字(c.followStatus) || "待跟进", 公海: 公海.has(id), salesOwnerId: 字(c.salesOwnerId),
      负责人: 字(c.salesOwnerId) === 我 ? "我" : 人名.get(字(c.salesOwnerId)) || "", remark: 字(c.remark),
      上次跟进: 跟[0]?.at ?? null,
      联系人: (联系人.get(id) ?? []).sort((a, b) => Number(b.主要) - Number(a.主要)),
      商机: 机, 计划: 计, 跟进: 跟,
    };
  });
}

/** 「今天」页：我的计划，按过期 / 今天 / 之后 3 天分好 */
export function 今天要跟(客户: 客户视图[], 我: string, 现在 = Date.now()) {
  const 今早 = new Date(现在); 今早.setHours(0, 0, 0, 0);
  const 起 = 今早.getTime(), 止 = 起 + 86400_000;
  const 有 = 客户.filter((c) => !c.公海 && c.计划 && c.计划.ownerId === 我).sort((a, b) => a.计划!.at - b.计划!.at);
  return {
    过期: 有.filter((c) => c.计划!.at < 起),
    今天: 有.filter((c) => c.计划!.at >= 起 && c.计划!.at < 止),
    之后: 有.filter((c) => c.计划!.at >= 止 && c.计划!.at < 止 + 3 * 86400_000),
  };
}

/** 客户页搜索：公司、联系人、国家、电话、邮箱、WhatsApp。电话忽略空格和横线 */
export function 搜(客户: 客户视图[], q: string): 客户视图[] {
  const s = q.trim().toLowerCase();
  if (!s) return 客户;
  const 数 = s.replace(/[\s\-()+]/g, "");
  return 客户.filter((c) => {
    const 字段 = [c.name, c.country, c.email, ...c.联系人.flatMap((p) => [p.name, p.email])].map((x) => x.toLowerCase());
    if (字段.some((x) => x.includes(s))) return true;
    if (数.length >= 3 && /^\d+$/.test(数)) return [c.phone, c.whatsapp, ...c.联系人.map((p) => p.phone)].some((x) => x.replace(/\D/g, "").includes(数));
    return false;
  });
}

/** 常见国家的旗子（中文名 → emoji）。没有的就不显示，不瞎猜 */
const 旗: Record<string, string> = {
  美国: "🇺🇸", 加拿大: "🇨🇦", 墨西哥: "🇲🇽", 巴西: "🇧🇷", 阿根廷: "🇦🇷", 智利: "🇨🇱", 哥伦比亚: "🇨🇴", 秘鲁: "🇵🇪",
  英国: "🇬🇧", 爱尔兰: "🇮🇪", 法国: "🇫🇷", 德国: "🇩🇪", 意大利: "🇮🇹", 西班牙: "🇪🇸", 葡萄牙: "🇵🇹", 荷兰: "🇳🇱", 比利时: "🇧🇪",
  瑞士: "🇨🇭", 奥地利: "🇦🇹", 瑞典: "🇸🇪", 挪威: "🇳🇴", 丹麦: "🇩🇰", 芬兰: "🇫🇮", 波兰: "🇵🇱", 捷克: "🇨🇿", 希腊: "🇬🇷",
  俄罗斯: "🇷🇺", 乌克兰: "🇺🇦", 土耳其: "🇹🇷", 立陶宛: "🇱🇹", 罗马尼亚: "🇷🇴", 匈牙利: "🇭🇺",
  阿联酋: "🇦🇪", 沙特阿拉伯: "🇸🇦", 沙特: "🇸🇦", 以色列: "🇮🇱", 卡塔尔: "🇶🇦", 科威特: "🇰🇼", 伊朗: "🇮🇷", 伊拉克: "🇮🇶", 埃及: "🇪🇬",
  南非: "🇿🇦", 尼日利亚: "🇳🇬", 肯尼亚: "🇰🇪", 摩洛哥: "🇲🇦", 阿尔及利亚: "🇩🇿", 加纳: "🇬🇭",
  中国: "🇨🇳", 香港: "🇭🇰", 中国香港: "🇭🇰", 台湾: "🇹🇼", 中国台湾: "🇹🇼", 日本: "🇯🇵", 韩国: "🇰🇷", 印度: "🇮🇳", 巴基斯坦: "🇵🇰", 孟加拉: "🇧🇩",
  越南: "🇻🇳", 泰国: "🇹🇭", 马来西亚: "🇲🇾", 新加坡: "🇸🇬", 印度尼西亚: "🇮🇩", 印尼: "🇮🇩", 菲律宾: "🇵🇭", 柬埔寨: "🇰🇭", 缅甸: "🇲🇲",
  澳大利亚: "🇦🇺", 新西兰: "🇳🇿",
};
export const 国旗 = (country: string) => 旗[country.trim()] ?? "";

export function 简称(name: string) {
  if (/[぀-ヿ一-鿿]/.test(name)) return name.trim().slice(0, 1);
  const w = name.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/);
  return ((w[0]?.[0] ?? "") + (w[1]?.[0] ?? "")).toUpperCase() || "·";
}
/** 头像底色：照桌面端 --avatar-1…8，按名字取模，同一个客户永远同一个色 */
export function 头像色(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(--avatar-${(h % 8) + 1})`;
}

export function 相对时间(t: number, 现在 = Date.now()): string {
  const 今早 = new Date(现在); 今早.setHours(0, 0, 0, 0);
  const 那天 = new Date(t); 那天.setHours(0, 0, 0, 0);
  const 差天 = Math.round((今早.getTime() - 那天.getTime()) / 86400_000);
  const hm = new Date(t).toTimeString().slice(0, 5);
  const d = 现在 - t;
  if (d >= 0 && d < 60_000) return "刚刚";
  if (d >= 0 && d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (差天 === 0) return `今天 ${hm}`;
  if (差天 === 1) return `昨天 ${hm}`;
  if (差天 === -1) return `明天 ${hm}`;
  if (差天 === -2) return `后天 ${hm}`;
  if (差天 > 1 && 差天 < 7) return `${差天} 天前`;
  const x = new Date(t);
  return `${x.getMonth() + 1}月${x.getDate()}日${差天 < 0 ? ` ${hm}` : ""}`;
}

export function 金额(n: number, cur: string) {
  const sym: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", CNY: "¥", JPY: "¥", HKD: "HK$" };
  return `${sym[cur] ?? `${cur} `}${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
