/**
 * 企业版建档的号码类型和格式校验（2026-10-26，测试清单 B2 / B4 / B5 / B6）。
 *
 * 对方原来的系统建档时先选「号码类型」再填号码，每种类型一条格式规矩，不合格当场说「格式错误」、
 * 认不出说「无法识别」，然后全公司查重。这里是规矩那一半：纯函数，浏览器和服务端都用这一份
 * （向导上当场提示，saveCustomer 再按同一份挡一次）。查重那一半在 lib/enterprise/contact-dedupe.ts。
 *
 * 规矩按清单原文：
 * - 手机号：国内 11 位；国外是 + 后面跟 8–15 位。+86 / 0086 开头、后面正好 11 位的当国内号（清单 B1）
 * - 邮箱：一个 @，@ 不在开头，@ 后面有点、点不紧挨 @；不能有连着的两个点、不能有全角句点；最后一段 2–6 个字母（B3）
 * - 微信：字母开头，6–20 位，只能是字母、数字、_、-（B4）
 * - 旺旺 ID：去掉空格和符号；4–30 位；允许一个 : 带子账号（B5）
 * - 二维码：选了这个类型就得上传一张图（B6）
 *
 * 「无法识别」= 清掉空白和符号以后什么都不剩，或者是打了码的样子（带 *）：不是填错了位数，是根本看不出是个号码。
 * 开关关着这份不被调（没有类型可选、保存不认 企业号码），见 saveCustomer
 */

export const 号码类型们 = ["手机号", "邮箱", "微信", "旺旺ID", "二维码"] as const;
export type 号码类型 = (typeof 号码类型们)[number];
export const 是号码类型 = (v: unknown): v is 号码类型 => (号码类型们 as readonly unknown[]).includes(v);

/** 向导下拉里能选的：二维码要传图，客户这一级还没有放图的地方（附件只挂商机 / 订单），先不给选 */
export const 向导能选类型: readonly 号码类型[] = ["手机号", "邮箱", "微信", "旺旺ID"];

/** 对方系统的提示原文（带图标），向导上照着显示 */
export const 号码提示 = {
  未选类型: "🔀请选择号码类型",
  无法识别: "🔎无法识别该号码",
  待上传: "📁请上传二维码图片",
  格式错误: {
    手机号: "⚠️手机号格式错误",
    邮箱: "⚠️邮箱号格式错误",
    微信: "⚠️微信号格式错误",
    旺旺ID: "⚠️旺旺ID格式错误",
    二维码: "📁请上传二维码图片",
  } satisfies Record<号码类型, string>,
} as const;

export type 验号结果 =
  /** 值 = 存进库的样子；键 = 查重比对用的（不分大小写的已经小写） */
  | { ok: true; 类型: 号码类型; 值: string; 键: string; 国外?: boolean }
  | { ok: false; 状态: "未选类型" | "无法识别" | "格式错误" | "待上传"; 提示: string };

const 错 = (类型: 号码类型): 验号结果 => ({ ok: false, 状态: "格式错误", 提示: 号码提示.格式错误[类型] });
const 认不出: 验号结果 = { ok: false, 状态: "无法识别", 提示: 号码提示.无法识别 };

/** 全角数字、全角加号、全角冒号换成半角 */
function 半角(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/＋/g, "+").replace(/：/g, ":");
}

/**
 * 手机号（B1 / B2）。分隔符（空格、横杠、括号、点）去掉；00 开头当 +。
 * 去完还夹着字母、汉字的算格式错误（不猜，和 lib/phone 的「号码中间夹字母不猜」一个意思）
 */
function 验手机(原: string): 验号结果 {
  let s = 半角(原).trim().replace(/^'/, "");
  if (s.includes("*")) return 认不出;
  s = s.replace(/[\s\-()（）.－—–‐‑‒―]/g, "");
  if (!/\d/.test(s)) return 认不出;
  s = s.replace(/^00(?=\d)/, "+");
  if (!/^\+?\d+$/.test(s)) return 错("手机号");
  // +86 13900000101 / 0086… / 86… 后面正好 11 位：国内号，存 11 位（和 规整手机号 一样）
  const 国内 = s.replace(/^\+?86(?=\d{11}$)/, "");
  if (/^\d{11}$/.test(国内)) return { ok: true, 类型: "手机号", 值: 国内, 键: 国内 };
  // +86 后面不是 11 位：国内号位数不对，不当国外号放过去
  if (/^\+86/.test(s)) return 错("手机号");
  if (/^\+\d{8,15}$/.test(s)) return { ok: true, 类型: "手机号", 值: s, 键: s.slice(1), 国外: true };
  return 错("手机号");
}

/** 邮箱（B3）。只去首尾空格；中间有空格算错 */
function 验邮箱(原: string): 验号结果 {
  const s = 原.trim();
  if (!s) return 认不出;
  if (s.includes("*")) return 认不出;
  const 好 =
    !/\s/.test(s) &&
    !s.includes("..") && !/[。．]/.test(s) &&
    s.split("@").length === 2 &&
    (() => {
      const [本地, 域] = s.split("@");
      if (!本地 || !域 || 域.startsWith(".") || !域.includes(".")) return false;
      return /^[A-Za-z]{2,6}$/.test(域.slice(域.lastIndexOf(".") + 1));
    })();
  return 好 ? { ok: true, 类型: "邮箱", 值: s, 键: s.toLowerCase() } : 错("邮箱");
}

/** 微信号（B4）。只去首尾空格；不分大小写比（和外贸的微信查重同一个键法） */
function 验微信(原: string): 验号结果 {
  const s = 原.trim();
  if (!s || s.includes("*")) return 认不出;
  return /^[a-zA-Z][a-zA-Z0-9_-]{5,19}$/.test(s) ? { ok: true, 类型: "微信", 值: s, 键: s.toLowerCase() } : 错("微信");
}

/**
 * 旺旺 ID（B5）：先去掉空格和符号（留字母、数字、_ 和子账号的 :），再看 4–30 位、最多一个 :。
 * 「主账号:子账号」是两个不同的人，查重整串比，主账号不认成子账号。不分大小写
 */
function 验旺旺(原: string): 验号结果 {
  const t = 半角(原);
  if (t.includes("*")) return 认不出;
  const s = t.replace(/[\s\p{P}\p{S}]/gu, (c) => (c === "_" || c === ":" ? c : ""));
  if (!s.replace(/[_:]/g, "")) return 认不出;
  const 好 = s.length >= 4 && s.length <= 30 && /^[a-zA-Z0-9_]+(:[a-zA-Z0-9_]+)?$/.test(s);
  return 好 ? { ok: true, 类型: "旺旺ID", 值: s, 键: s.toLowerCase() } : 错("旺旺ID");
}

/**
 * 按选的类型验一个号码。二维码看 有图（号码那格不用填）；其余类型 有图 不看
 */
export function 验号码(类型: unknown, 原: unknown, 选项: { 有图?: boolean } = {}): 验号结果 {
  if (!是号码类型(类型)) return { ok: false, 状态: "未选类型", 提示: 号码提示.未选类型 };
  if (类型 === "二维码") {
    return 选项.有图 ? { ok: true, 类型, 值: "", 键: "" } : { ok: false, 状态: "待上传", 提示: 号码提示.待上传 };
  }
  const s = typeof 原 === "string" ? 原 : "";
  if (类型 === "手机号") return 验手机(s);
  if (类型 === "邮箱") return 验邮箱(s);
  if (类型 === "微信") return 验微信(s);
  return 验旺旺(s);
}

/** 查重结果的提示原文（B8）。没做的三条见 contact-dedupe.ts 头注 */
export const 查重提示 = {
  首次录入: "✅首次录入",
  公海待捞: "⛔号码为公海待捞状态",
  我的通讯录已有: "📒我的通讯录已有该号码",
  重复: (同事: string) => `⛔号码重复，可与 ${同事} 沟通核实`,
} as const;
