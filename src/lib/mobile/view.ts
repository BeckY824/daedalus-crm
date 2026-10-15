/**
 * 手机库里的行 → 界面要的样子（2026-10-15）。纯函数，不碰存储、不碰网络（tests/mobile-view.test.ts）。
 *
 * 库里的值有两种来路：电脑同步来的（SQLite 里的原样：时间是毫秒数、布尔是 0/1）和手机自己记的（毫秒数、true/false）。
 * 这里统一读法：时间 → 毫秒，布尔 → true/false。
 */
import type { 记录 } from "./sync";
import { 没开通话 } from "@/lib/team-pricing";

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

/* ---------------- 同步状态条（今天页标题下、「我的」里那一枚） ---------------- */

/**
 * 样子对应 m.css 的 .m-sync：ok 绿、wait 品牌色、off 黄（离线 / 没成功，多半自己会好）、stop 红（团队暂停，要人去续费 / 开通）
 */
export type 同步条 = {
  样子: "ok" | "wait" | "off" | "stop";
  字: string;
  /** 出错时点开看的：为什么、该怎么办 */
  详?: { 标题: string; 原因: string; 怎么办: string };
};

/**
 * 同步状态条显示什么（2026-10-15）。之前只看上次同步时间：团队到期被服务端拒了，还写「已同步 · 刚刚」。
 * 出错按服务端的话分（lib/team-pricing.ts 的 没开通话 / 到期话，402）：到期 → 暂停；待开通、停用 → 没开通；断网 → 离线；其它 → 没成功。
 * 出错时排在「同步中」前面：每 30 秒自动试一轮，不能在「暂停」和「同步中」之间来回跳；成功一轮 lastError 就清掉了。
 */
export function 同步条(x: { 断网: boolean; 待同步: number; 在同步: boolean; 上次成功: number | null; 错误: string | null; 现在: number }): 同步条 {
  const 待 = x.待同步 ? `，手机上新记的 ${x.待同步} 条先存在这台手机上，恢复后自动传上去` : "";
  if (x.断网 || (x.错误 && /连不上网络/.test(x.错误))) return { 样子: "off", 字: `离线${x.待同步 ? ` · ${x.待同步} 条待同步` : ""}` };
  if (x.错误) {
    if (/已到期/.test(x.错误)) {
      const 日 = /（(\d{4}-\d{2}-\d{2})）/.exec(x.错误)?.[1];
      return {
        样子: "stop", 字: "团队已到期，暂停同步",
        详: { 标题: "团队同步已到期", 原因: `团队同步${日 ? `在 ${日} ` : ""}到期了，服务器暂停了这个团队的同步。`, 怎么办: `续费后自动恢复，这台手机上的内容照常能看${待}。续费请团队老板私信我们。` },
      };
    }
    if (x.错误.includes(没开通话) || /停用/.test(x.错误)) {
      return {
        样子: "stop", 字: "团队没开通，暂不同步",
        详: { 标题: "团队同步没开通", 原因: "这个团队的同步还没开通，或者已经停用了，服务器暂时不给同步。", 怎么办: `开通后自动开始同步，这台手机上的内容照常能看${待}。开通请团队老板私信我们。` },
      };
    }
    return {
      样子: "off", 字: "同步没成功",
      详: { 标题: "同步没成功", 原因: x.错误, 怎么办: `手机每 30 秒会自己再试一次，这台手机上的内容照常能看${待}。一直不好的话，点「再试一次」，或者联系我们。` },
    };
  }
  if (x.在同步 || x.待同步) return { 样子: "wait", 字: x.待同步 ? `${x.待同步} 条同步中` : "同步中" };
  if (!x.上次成功) return { 样子: "wait", 字: "还没同步" };
  // 界面的「现在」30 秒才走一次，刚同步完的时间会比它新：按「刚刚」算，别显示成「今天 hh:mm」
  return { 样子: "ok", 字: `已同步 · ${相对时间(x.上次成功, Math.max(x.现在, x.上次成功))}` };
}

/**
 * 第一次从团队同步就失败时那一页说什么（2026-10-15）。这时手机上还什么都没有，不能说「内容照常能看」；
 * 服务端原话写的是「这台电脑」，也不能直接搬
 */
export function 首次同步失败(错误: string): { 标题: string; 话: string } {
  if (/连不上网络/.test(错误)) return { 标题: "没连上网络", 话: "连上网后点「再试一次」。" };
  if (/已到期/.test(错误)) {
    const 日 = /（(\d{4}-\d{2}-\d{2})）/.exec(错误)?.[1];
    return { 标题: "团队同步已到期", 话: `团队同步${日 ? `在 ${日} ` : ""}到期了，暂时同步不下来。续费后点「再试一次」就行，续费请团队老板私信我们。` };
  }
  if (错误.includes(没开通话) || /停用/.test(错误)) return { 标题: "团队同步没开通", 话: "这个团队的同步还没开通，或者已经停用了。开通后点「再试一次」就行，开通请团队老板私信我们。" };
  return { 标题: "没同步下来", 话: 错误 };
}
