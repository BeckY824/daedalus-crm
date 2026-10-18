/**
 * 正文里的引用和「没查到进口记录」（10-18 免费对比复核第 2、1 点）。
 *
 * 引用：模型写结论时常在句子里带材料编号（「来源:17,28」「[17]」）。那是这次背调内部材料的序号（几十条），
 * 报告末尾【来源】只列引用过的那十几条、另编了号——原样留着用户点不到，还会碰巧撞上别的来源
 * （Ansell：「来源:6」指 OCTO 页，列表里 [6] 却是 S19 目录）。出报告前换成【来源】里的编号，对不上的删掉。
 * 开发信是发给客户的，引用一律删。
 *
 * 进口：英国公司 HMRC 名录查到了进口记录（或者模型认出一条带来源的），结论里还写「未查到公开采购或进口记录」
 * 就前后打架了（Ansell：【公司】90 个月进口，【各步结论 · 切入建议】又说没查到）。查到的时候把那半句删掉。
 */

const 号列 = String.raw`\d{1,3}(?:\s*[,，、]\s*\d{1,3})*`;
/** 「；来源:17,28」「（来源：3、5）」「来源 17」：前面的分号 / 逗号、外面的括号一起算进去 */
const 来源式 = new RegExp(String.raw`\s*[；;，,]?\s*[（(]?\s*(?:来源|出处)\s*[:：]?\s*(${号列})\s*[)）]?`, "g");
/** 「[17]」「[17, 28]」「【17】」，连着几个的一起 */
const 方括号式 = new RegExp(String.raw`\s*(?:[\[【]\s*${号列}\s*[\]】]\s*)+`, "g");
/** 两种写法一次换完（分两遍的话，第一遍换出来的 [3] 会被第二遍当成材料编号再换一次） */
const 引用式 = new RegExp(`${来源式.source}|${方括号式.source}`, "g");

const 收尾 = (t: string) =>
  t
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([。；，、！？.,;:!?)）])/g, "$1")
    .replace(/[；;，,]+([。.])/g, "$1")
    .replace(/[；;，,]+$/, "")
    .trim();

/**
 * 把正文里的材料编号换成【来源】列表的编号。
 * 网址: 材料编号 → 那条材料的网址；列表: 报告【来源】里的网址（按编号顺序）。认不出、不在列表里的删掉
 */
export function 换引用(text: string, 网址: (n: number) => string | undefined, 列表: readonly string[]): string {
  if (!text) return text;
  const 换 = (段: string) => {
    const 号们: number[] = [];
    for (const m of 段.matchAll(/\d{1,3}/g)) {
      const u = 网址(Number(m[0]));
      const i = u ? 列表.indexOf(u) : -1;
      if (i >= 0 && !号们.includes(i + 1)) 号们.push(i + 1);
    }
    return 号们.length ? ` ${号们.map((n) => `[${n}]`).join("")}` : "";
  };
  return 收尾(text.replace(引用式, (段) => 换(段) || (/^\s*[\[【]/.test(段) ? " " : "")));
}

/** 引用全删（开发信：发给客户的，不带我们的材料编号）。多行原样留着，只删「[17]」这种和它前面的空格 */
export function 删引用(text: string): string {
  if (!text) return text;
  return text.replace(/[ \t]*(?:[\[【][ \t]*\d{1,3}(?:[ \t]*[,，、][ \t]*\d{1,3})*[ \t]*[\]】])+/g, "").replace(/[ \t]+([.,;:!?)])/g, "$1");
}

/** 一小段里说「没查到进口 / 提单 / 海关记录」 */
const 没进口 = /(?:未|没有?|无公开|查不到|找不到)[^，,。；;]*?(?:进口|提单|海关)|(?:进口|提单|海关)[^，,。；;]*?(?:查不到|未查到|没查到|没有找到|未找到|没找到)/;

/**
 * 查到了进口记录：把「未查到……进口记录」那一小段（逗号、分号、句号隔开的）删掉，后面跟着的引用编号留着。
 * 整句都是这个意思就返回空串
 */
export function 去掉没查到进口(text: string): string {
  if (!text || !没进口.test(text)) return text;
  const 段 = text.split(/(?<=[，,。；;])/);
  const 留: string[] = [];
  const 引: string[] = [];
  for (const s of 段) {
    if (没进口.test(s)) 引.push(...(s.match(/\[\d{1,3}\]/g) ?? []));
    else 留.push(s);
  }
  const t = 留.join("").trim().replace(/[，,；;。.]+$/, "");
  if (!t) return "";
  const 补 = [...new Set(引)].filter((x) => !t.includes(x)).join("");
  return `${t}${补 ? ` ${补}` : ""}。`;
}
