/**
 * 公司名比对：查工商库、制裁名单、认社媒链接都要判断「这条说的是不是这家」。
 *
 * 规整：去重音、小写、去掉公司类型后缀（GmbH / Ltd / S.A. / 有限公司……）和标点，切成词。
 * 判定只有两档，宁可漏不可错：
 *   同  规整以后一字不差（「SLV GmbH」和「SLV」）
 *   近  一边的词全在另一边里，另一边最多多 2 个词（「SLV」和「SLV Lighting Group GmbH」）
 * 硬红（已注销、制裁命中）只认「同」。
 */

const 后缀 = new Set([
  "gmbh", "mbh", "ag", "kg", "ohg", "ug", "ev", "co", "kgaa", "se",
  "ltd", "limited", "llc", "llp", "lp", "inc", "incorporated", "corp", "corporation", "company", "plc", "pllc",
  "sa", "sas", "sasu", "sarl", "eurl", "sl", "slu", "srl", "spa", "snc", "sac", "saa", "ltda", "eireli", "me", "epp",
  "bv", "nv", "vof", "cv", "bvba", "sprl", "srl",
  "as", "asa", "ab", "publ", "oy", "oyj", "aps", "a/s", "hf", "ehf",
  "sp", "zoo", "z", "o", "o.o", "oo", "sro", "spol", "s", "ro", "as", "kft", "zrt", "nyrt", "doo", "ad", "ood", "eood",
  // 波兰白名单里是全称（「SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ」）；ł 去重音以后不变
  "społka", "spolka", "ograniczona", "odpowiedzialnoscia", "akcyjna", "komandytowa", "komandytowo", "jawna", "cywilna",
  "pty", "pte", "bhd", "sdn", "tbk", "pt", "jsc", "pjsc", "ojsc", "zao", "ooo", "oao",
  "fze", "fzco", "fzc", "fzllc", "est", "wll",
  "kk", "gk", "yk",
  "the", "und", "and", "et", "&",
]);

/** 「Rexel France S.A.S.」→ ["rexel","france"]。中日韩文字原样留着（「有限公司」这类后缀去掉） */
export function 名词(s: string): string[] {
  const t = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/(股份)?有限(责任)?公司|集团|公司/g, " ")
    // S.A. / S.A.S. / B.V. / Sp. z o.o. 先把点去掉再切，不然切成一个个字母
    .replace(/\b([a-z])\.(?=[a-z]\.?)/g, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const 词 = t.split(/\s+/).filter(Boolean);
  const 留 = 词.filter((w) => !后缀.has(w));
  return 留.length ? 留 : 词;
}

export function 规整名(s: string): string {
  return 名词(s).join(" ");
}

export type 像不像 = "同" | "近" | null;

export function 比名字(a: string, b: string): 像不像 {
  const x = 名词(a);
  const y = 名词(b);
  if (!x.length || !y.length) return null;
  if (x.join(" ") === y.join(" ")) return "同";
  // 连写和分开写算同一个（「Delta Light」和「DeltaLight」）
  if (x.join("") === y.join("")) return "同";
  const [少, 多] = x.length <= y.length ? [x, y] : [y, x];
  if (少.every((w) => 多.includes(w)) && 多.length - 少.length <= 2) return "近";
  return null;
}

/** 名字里能拿去查的那一截：去掉中文说明（「SLV 德国」→「SLV」）。全是中文就原样 */
export function 查询名(公司: string): string {
  const 拉丁 = 公司.replace(/[　-鿿＀-￯]+/g, " ").replace(/\s+/g, " ").trim();
  return 拉丁.length >= 2 ? 拉丁 : 公司.trim();
}

/** 一段文字里有没有提到这家（按词，「SLV」不能从「SLVR」里认出来） */
export function 提到了(文字: string, 公司: string): boolean {
  const 词 = 名词(公司);
  if (!词.length) return false;
  const 文 = 名词(文字).join(" ");
  const 连写 = 文.replace(/ /g, "");
  return ` ${文} `.includes(` ${词.join(" ")} `) || (词.length > 1 && 连写.includes(词.join("")));
}
