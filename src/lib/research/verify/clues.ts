/**
 * 真实性核对要靠对方自报的东西：邮箱、电话、官网、税号、自称哪国（方案 3.3）。两个来处：
 *   - 从客户详情页发起：档案里的邮箱、电话、WhatsApp、官网、国家（stream.ts 带上）
 *   - 用户那句话里顺手贴的：「帮我查 john@slv-lighting.co 这个客户，电话 +971 50 …，税号 DE123456789」
 * 这里只认格式（正则），不猜；认不出就是没提供。
 */
import { 主机, 是免费邮箱 } from "./domain";
import { 认税号 } from "./registry";

export type 线索 = { 邮箱: string[]; 电话: string[]; 官网?: string; 税号?: string; 国家?: string };

export const 空线索 = (): 线索 => ({ 邮箱: [], 电话: [] });

export function 认线索(text: string | undefined | null): 线索 {
  const 出 = 空线索();
  const t = text ?? "";
  if (!t.trim()) return 出;
  出.邮箱 = [...new Set([...t.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0].toLowerCase()))].slice(0, 3);
  // 电话：+ 开头的国际号码（8–15 位数字，中间可以有空格、横线、括号）。不带 + 的本地号码不认：分不清是电话还是别的数
  出.电话 = [...new Set([...t.matchAll(/\+\d[\d\s().-]{6,20}\d/g)].map((m) => m[0].replace(/\s+/g, " ").trim()).filter((x) => x.replace(/\D/g, "").length >= 8 && x.replace(/\D/g, "").length <= 15))].slice(0, 3);
  // 税号：欧盟国家两位字母 + 号码（DE123456789 / FR74479973513 / NL123456789B01）
  for (const m of t.matchAll(/\b([A-Z]{2}[\s-]?[0-9][0-9A-Z\s-]{6,14}[0-9A-Z])\b/g)) {
    const v = 认税号(m[1]);
    if (v) {
      出.税号 = `${v.国}${v.号}`;
      break;
    }
  }
  // 官网：贴的网址或裸域名（邮箱里的域名不算）
  const 去邮箱 = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, " ");
  const 网 = /(?:https?:\/\/)?(?:www\.)?([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?:\/\S*)?/i.exec(去邮箱);
  if (网) {
    const h = 主机(网[0]);
    if (h && !是免费邮箱(h) && !/\.(png|jpe?g|pdf|docx?|xlsx?)$/i.test(h)) 出.官网 = h.replace(/^www\./, "");
  }
  return 出;
}

export function 合并线索(...列: (Partial<线索> | undefined)[]): 线索 {
  const 出 = 空线索();
  for (const x of 列) {
    if (!x) continue;
    出.邮箱 = [...new Set([...出.邮箱, ...(x.邮箱 ?? [])])].slice(0, 3);
    出.电话 = [...new Set([...出.电话, ...(x.电话 ?? [])])].slice(0, 3);
    出.官网 ??= x.官网;
    出.税号 ??= x.税号;
    出.国家 ??= x.国家;
  }
  return 出;
}
