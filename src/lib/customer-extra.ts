/**
 * 客户的外贸档案（2026-10-05，外贸客户建议）：国家、WhatsApp、微信、邮箱、来源；2026-10-16 加客户等级、官网。
 * 存在旁表 CustomerExtra（Customer 是 schema 建的老表，不能加列）。不碰数据库的规则放这里，客户端服务端都能引；
 * 读写在 lib/customer-extra-db.ts。
 *
 * 客户原话：「增加列：国家，Whatsapp，Wechat，邮箱」。「来源」是我们补的：外贸模版不摆渠道（推荐人 / 分佣链），
 * 客户说「线索里面已经有来源」——可直接建、Excel 导入的客户不经过线索，客户自己身上得有地方记来源。
 */

export const 外贸键 = ["country", "whatsapp", "wechat", "email", "source", "level", "website"] as const;
export type 外贸键 = (typeof 外贸键)[number];
export type 外贸档案 = Record<外贸键, string | null>;

export const 外贸字段名: Record<外贸键, string> = {
  country: "国家",
  whatsapp: "WhatsApp",
  wechat: "微信",
  email: "邮箱",
  source: "来源",
  level: "客户等级",
  website: "官网",
};

/**
 * 客户等级（2026-10-16 外贸基础，迁移 037）：只有 A / B / C / D 四档，空 = 没分级。
 * 只是一个让人按等级分配精力的标记，不配节奏、不算分（总控 10-16：「不做按等级配节奏」）
 */
export const 客户等级 = ["A", "B", "C", "D"] as const;
export type 客户等级 = (typeof 客户等级)[number];
/** 下拉里的说法：等级本身只存一个字母 */
export const 客户等级说明: Record<客户等级, string> = { A: "A 重点", B: "B 常规", C: "C 培育", D: "D 唤醒" };
/** 列表排序用：A 在前，没分级的最后 */
export const 等级序 = (v: string | null | undefined): number => {
  const i = (客户等级 as readonly string[]).indexOf(String(v ?? ""));
  return i < 0 ? 客户等级.length : i;
};

/** 人或表里写的等级 → 大写字母：「a」「A级」「A 类」都认成 A，「重点」这类说法不认（返回 undefined）；空返回 null */
export function 认等级(v: unknown): 客户等级 | null | undefined {
  const t = String(v ?? "").trim().toUpperCase().replace(/\s+/g, "").replace(/(级|类|等)$/u, "");
  if (!t) return null;
  return (客户等级 as readonly string[]).includes(t) ? (t as 客户等级) : undefined;
}

/**
 * 官网（迁移 038）：存人填的样子，去掉首尾空格和末尾斜杠；点开时没写协议的补 https://。
 * 只许 http(s)，也不许带空格、不许没有点——防的是把一句话或 javascript: 当网址存进来
 */
export function 规整官网(v: unknown): { ok: true; v: string | null } | { ok: false; error: string } {
  const s = String(v ?? "").trim().slice(0, 200).replace(/\/+$/, "");
  if (!s) return { ok: true, v: null };
  if (/\s/.test(s)) return { ok: false, error: "官网里不能有空格" };
  const 去协议 = s.replace(/^https?:\/\//i, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(去协议) || !/^[^/?#]+\.[^/?#.]{2,}/.test(去协议)) return { ok: false, error: "官网格式不对，例如 www.example.com" };
  return { ok: true, v: s };
}

/** 官网点开的网址：没写协议补 https://；不像网址的不给链接 */
export function 官网网址(v: string | null | undefined): string | null {
  const r = 规整官网(v);
  if (!r.ok || !r.v) return null;
  return /^https?:\/\//i.test(r.v) ? r.v : `https://${r.v}`;
}

/** 列表里显示的官网：去掉协议和 www.，短一点 */
export function 官网短写(v: string | null | undefined): string {
  return String(v ?? "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
}

/** 每一格最长多少字：国家、来源是短名字；邮箱按 RFC 上限 */
const 上限: Record<外贸键, number> = { country: 40, whatsapp: 40, wechat: 60, email: 254, source: 40, level: 4, website: 200 };

export const 空档案 = (): 外贸档案 => ({ country: null, whatsapp: null, wechat: null, email: null, source: null, level: null, website: null });

/**
 * 规整一格：去首尾空格、截长度、空串当没填。邮箱不合格式报错（只看有没有 @ 和点——
 * 再严就会把人手里真实存在的怪邮箱拒掉）；WhatsApp 只许数字、空格、+、-、括号
 */
export function 规整外贸格(k: 外贸键, v: unknown): { ok: true; v: string | null } | { ok: false; error: string } {
  if (k === "level") {
    const 等 = 认等级(v);
    return 等 === undefined ? { ok: false, error: "客户等级只能是 A / B / C / D" } : { ok: true, v: 等 };
  }
  if (k === "website") return 规整官网(v);
  const s = typeof v === "string" ? v.trim().slice(0, 上限[k]) : v == null ? "" : String(v).trim().slice(0, 上限[k]);
  if (!s) return { ok: true, v: null };
  if (k === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { ok: false, error: "邮箱格式不对" };
  if (k === "whatsapp" && !/^[+\d\s\-()（）]+$/.test(s)) return { ok: false, error: "WhatsApp 号只能是数字（可以带 + 和空格）" };
  if (k === "whatsapp" && s.replace(/\D/g, "").length < 6) return { ok: false, error: "WhatsApp 号太短了" };
  return { ok: true, v: s };
}

/** 一整份（或一部分）规整好；给了才算，没给的键不出现在结果里（= 不碰） */
export function 规整外贸档案(x: Partial<Record<外贸键, unknown>> | null | undefined): { ok: true; data: Partial<外贸档案> } | { ok: false; error: string } {
  const data: Partial<外贸档案> = {};
  if (!x) return { ok: true, data };
  for (const k of 外贸键) {
    if (!(k in x) || x[k] === undefined) continue;
    const r = 规整外贸格(k, x[k]);
    if (!r.ok) return r;
    data[k] = r.v;
  }
  return { ok: true, data };
}

/** WhatsApp 点开对话的网址（wa.me 只认纯数字的国际号，不带 +） */
export function WhatsApp网址(号: string | null | undefined): string | null {
  // 共享试用区打了码的号（+86****1111）：剩下的几位拼出来是个陌生号码，不给链接
  if (String(号 ?? "").includes("*")) return null;
  const d = String(号 ?? "").replace(/\D/g, "");
  return d.length >= 6 ? `https://wa.me/${d}` : null;
}

/**
 * 国家候选（能选也能填）：按外贸常见市场分组排，名字用日常叫法（「阿联酋」不写「阿拉伯联合酋长国」）。
 * 写死不走 Intl.DisplayNames：Node 和各浏览器的 ICU 版本叫法不一样，存进库里的同一个国家会有两种写法，筛选就漏了
 */
export const 国家候选: { 组: string; 国家: string[] }[] = [
  { 组: "北美 / 欧洲", 国家: ["美国", "加拿大", "英国", "德国", "法国", "意大利", "西班牙", "荷兰", "比利时", "波兰", "瑞典", "瑞士", "奥地利", "爱尔兰", "葡萄牙", "希腊", "捷克", "罗马尼亚", "匈牙利", "丹麦", "挪威", "芬兰", "乌克兰", "俄罗斯"] },
  { 组: "中东 / 中亚", 国家: ["阿联酋", "沙特阿拉伯", "卡塔尔", "科威特", "阿曼", "巴林", "以色列", "约旦", "伊拉克", "伊朗", "土耳其", "埃及", "乌兹别克斯坦", "哈萨克斯坦", "吉尔吉斯斯坦", "塔吉克斯坦", "土库曼斯坦", "格鲁吉亚", "阿塞拜疆", "亚美尼亚", "阿富汗", "巴基斯坦"] },
  { 组: "亚太", 国家: ["日本", "韩国", "印度", "越南", "泰国", "马来西亚", "新加坡", "印度尼西亚", "菲律宾", "缅甸", "柬埔寨", "孟加拉国", "斯里兰卡", "尼泊尔", "蒙古", "澳大利亚", "新西兰", "中国香港", "中国台湾", "中国澳门", "中国"] },
  { 组: "拉美", 国家: ["墨西哥", "巴西", "阿根廷", "智利", "秘鲁", "哥伦比亚", "厄瓜多尔", "委内瑞拉", "巴拿马", "哥斯达黎加", "多米尼加", "乌拉圭", "巴拉圭", "玻利维亚"] },
  { 组: "非洲", 国家: ["南非", "尼日利亚", "肯尼亚", "埃塞俄比亚", "加纳", "坦桑尼亚", "摩洛哥", "阿尔及利亚", "突尼斯", "利比亚", "安哥拉", "乌干达", "科特迪瓦", "塞内加尔", "喀麦隆", "刚果（金）", "苏丹"] },
];

/** 常见写法 → 候选里的叫法：导入时表里写「UAE」「USA」也认得 */
const 别名: Record<string, string> = {
  usa: "美国", us: "美国", "united states": "美国", america: "美国",
  uk: "英国", "united kingdom": "英国", england: "英国", britain: "英国",
  uae: "阿联酋", "united arab emirates": "阿联酋", 阿拉伯联合酋长国: "阿联酋", dubai: "阿联酋", 迪拜: "阿联酋",
  ksa: "沙特阿拉伯", "saudi arabia": "沙特阿拉伯", 沙特: "沙特阿拉伯",
  germany: "德国", france: "法国", italy: "意大利", spain: "西班牙", netherlands: "荷兰", poland: "波兰",
  russia: "俄罗斯", turkey: "土耳其", "türkiye": "土耳其", india: "印度", japan: "日本", korea: "韩国", "south korea": "韩国",
  vietnam: "越南", "viet nam": "越南", thailand: "泰国", malaysia: "马来西亚", singapore: "新加坡", indonesia: "印度尼西亚", 印尼: "印度尼西亚",
  philippines: "菲律宾", australia: "澳大利亚", canada: "加拿大", mexico: "墨西哥", brazil: "巴西", chile: "智利", peru: "秘鲁",
  colombia: "哥伦比亚", argentina: "阿根廷", "south africa": "南非", nigeria: "尼日利亚", kenya: "肯尼亚", egypt: "埃及",
  uzbekistan: "乌兹别克斯坦", kazakhstan: "哈萨克斯坦", georgia: "格鲁吉亚", pakistan: "巴基斯坦", israel: "以色列",
  qatar: "卡塔尔", kuwait: "科威特", oman: "阿曼", "hong kong": "中国香港", hongkong: "中国香港", 香港: "中国香港",
  taiwan: "中国台湾", 台湾: "中国台湾", macau: "中国澳门", 澳门: "中国澳门", china: "中国",
};

/** 人或表里写的国家 → 统一叫法；不认识的原样留着（能选也能填） */
export function 认国家(s: string | null | undefined): string | null {
  const t = String(s ?? "").trim();
  if (!t) return null;
  return 别名[t.toLowerCase()] ?? t;
}

/** 表单里的档案五格和打开时比，只留变了的（空串当空）。新建时 editing 没有，交所有填了的 */
export function 改过的档案(填: Partial<Record<keyof 外贸档案, string | null | undefined>> | undefined, 原: 外贸档案 | null | undefined): Partial<外贸档案> {
  const 出: Partial<外贸档案> = {};
  for (const k of 外贸键) {
    const 新 = (填?.[k] ?? "").trim() || null;
    if (新 !== ((原?.[k] ?? "").trim() || null)) 出[k] = 新;
  }
  return 出;
}

