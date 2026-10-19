/**
 * 国家名 ↔ ISO 两位码。档案里存的是中文（「阿联酋」「美国」），模型写的是「德国汉堡」「Germany, Hamburg」，
 * 制裁名单里是英文全称（「United Kingdom」）——都认成同一个两位码再比。
 *
 * 名字表用运行时自带的 Intl.DisplayNames 生成（中英两套），再补一些常用简称。
 */

const 简称: Record<string, string> = {
  阿联酋: "AE",
  沙特: "SA",
  沙特阿拉伯: "SA",
  英国: "GB",
  美国: "US",
  韩国: "KR",
  俄罗斯: "RU",
  捷克: "CZ",
  台湾: "TW",
  香港: "HK",
  澳门: "MO",
  土耳其: "TR",
  荷兰: "NL",
  "united states of america": "US",
  usa: "US",
  uk: "GB",
  "great britain": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  uae: "AE",
  "russian federation": "RU",
  "korea, republic of": "KR",
  "south korea": "KR",
  "north korea": "KP",
  "korea, north": "KP",
  "iran (islamic republic of)": "IR",
  "syrian arab republic": "SY",
  "türkiye": "TR",
  turkey: "TR",
  czechia: "CZ",
  "czech republic": "CZ",
  holland: "NL",
  deutschland: "DE",
  "the netherlands": "NL",
  "viet nam": "VN",
  "lao people's democratic republic": "LA",
  burma: "MM",
};

let 表: { 名: string; 码: string }[] | null = null;

function 名字表(): { 名: string; 码: string }[] {
  if (表) return 表;
  const 出 = new Map<string, string>();
  const zh = new Intl.DisplayNames(["zh"], { type: "region" });
  const en = new Intl.DisplayNames(["en"], { type: "region" });
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const a of A)
    for (const b of A) {
      const 码 = a + b;
      // 作废的旧码（SU 苏联、DD 东德、FX、YU……）显示名和现在的国家一样，会把「德国」认成 DD：只收规范码。
      // 再去掉不是国家的（EU 欧盟、UN、ZZ 未知、Q* / X* 私用段；XK 科索沃留着）
      if (/^(EU|EZ|UN|ZZ|Q[M-Z]|X[A-JL-Z])$/.test(码) || Intl.getCanonicalLocales(`und-${码}`)[0] !== `und-${码}`) continue;
      for (const d of [zh, en]) {
        let n: string | undefined;
        try {
          n = d.of(码);
        } catch {
          n = undefined;
        }
        // 认不出的码 Intl 原样返回，不收
        if (n && n !== 码) 出.set(n.toLowerCase(), 码);
      }
    }
  for (const [k, v] of Object.entries(简称)) 出.set(k.toLowerCase(), v);
  // 长名字先比：「美属萨摩亚」不能先被「萨摩亚」认走
  表 = [...出.entries()].map(([名, 码]) => ({ 名, 码 })).sort((x, y) => y.名.length - x.名.length);
  return 表;
}

/** 一段文字里提到的国家 → 两位码；认不出 undefined。已经是两位码的直接收 */
export function 认国家(text: string | undefined | null): string | undefined {
  const t = text?.trim();
  if (!t) return undefined;
  if (/^[A-Za-z]{2}$/.test(t)) {
    const 码 = t.toUpperCase();
    return 码 === "UK" ? "GB" : 名字表().some((x) => x.码 === 码) ? 码 : undefined;
  }
  const s = t.toLowerCase();
  for (const { 名, 码 } of 名字表()) {
    // 英文名按词认（「oman」不能从「romania」里认出来）；中文名按子串
    if (/^[a-z]/.test(名) ? new RegExp(`(^|[^a-z])${名.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z])`).test(s) : s.includes(名)) return 码;
  }
  return undefined;
}

/** 两位码 → 中文名（「DE」→「德国」）；认不出原样返回 */
export function 国名(码: string | undefined): string {
  if (!码) return "";
  try {
    return 简称中文[码] ?? new Intl.DisplayNames(["zh"], { type: "region" }).of(码) ?? 码;
  } catch {
    return 码;
  }
}
const 简称中文: Record<string, string> = { AE: "阿联酋", GB: "英国", US: "美国", KR: "韩国" };

/** 英国的海峡群岛、马恩岛号码归属算英国（libphonenumber 把 +44 7911… 认成 GG） */
export function 同一国(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const 归 = (x: string) => (["GG", "JE", "IM"].includes(x) ? "GB" : x);
  return 归(a) === 归(b);
}
