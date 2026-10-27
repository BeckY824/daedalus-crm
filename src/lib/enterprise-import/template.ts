/**
 * 对照表：把试跑报告里「列落到哪个字段、阶段这些值怎么换、负责人对谁」导成一张表，给原系统那边的人填；
 * 填好传回来，换成 映射改动 再试跑一遍（重新试跑）。
 *
 * 原系统的列名、阶段叫法、负责人写法每家都不一样，代码里不写死任何一家的——全在这张表里，由客户填。
 * 导出时已经按规则 / AI 猜好了，客户只改不对的、补空着的。
 *
 * 表就五列：类别 / 哪一类 / 原系统写法 / 我们这边 / 能填的。
 *   - 类别「列」：哪一类 = 客户、联系人……；我们这边填字段的中文名（「原系统 ID」= 原系统里每条的编号，再导一次靠它认出同一条），或「拼进备注」「不用」
 *   - 类别「商机阶段」「线索状态」「跟进方式」「客户跟进状态」：我们这边填「能填的」里的一个
 *   - 类别「负责人」：我们这边填成员的名字或邮箱（重名的只能填邮箱）；空着 = 落到默认负责人
 *   - 类别「默认负责人」：一行，对不上的负责人落到谁名下
 *
 * 纯函数，不碰库：导出给报告，读回给报告 + 成员名单。
 */
import { 解析CSV带行号, 解码CSV } from "../import/parse";
import { 读xlsx各表 } from "../import/xlsx";
import { 规整表头 } from "../import/fields";
import { 合法值, 值对照, 值说法, 进备注, type 成员, type 业务 } from "./mapping";
import { 实体顺序, 标准字段, 字段中文, 实体名, type 实体, type 值对照名 } from "./types";
import type { 试跑报告, 映射改动 } from "./report";

export const 对照表头 = ["类别", "哪一类", "原系统写法", "我们这边", "能填的"] as const;

const 不用 = "不用";
const 拼进 = (e: 实体) => (e === "followup" ? "拼进内容" : "拼进备注");

/** 以这些开头的格 Excel 会当公式算（原系统数据里混进「=HYPERLINK(...)」这种），导出时前面垫一个 '，读回去掉 */
const 像公式 = /^[=+\-@\t\r]/;

/** 一格里有逗号、引号、换行的要包引号；像公式的先垫 ' */
function 格(s: string): string {
  const v = 像公式.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** 读回时去掉导出垫的 ' */
function 去垫(s: string): string {
  return s.startsWith("'") && 像公式.test(s.slice(1)) ? s.slice(1) : s;
}

/** 成员怎么写进表里：名字唯一写名字，重名的写邮箱（没邮箱的写名字，读回时会提醒重名） */
function 成员写法(id: string, 成员们: readonly 成员[]): string {
  const u = 成员们.find((x) => x.id === id);
  if (!u) return "";
  const 同名 = 成员们.filter((x) => x.name.trim() === u.name.trim()).length;
  return 同名 > 1 && u.email ? u.email : u.name;
}

const 负责人写法 = (id: string, 成员们: readonly 成员[]) => (id ? 成员写法(id, 成员们) : "");
const 默认负责人写法 = (报告: 试跑报告, 成员们: readonly 成员[]) => 成员写法(报告.映射.默认负责人.id, 成员们) || 报告.映射.默认负责人.名;

/** 导出：按报告当前的映射，一行一项。返回带 BOM 的 CSV 文本（Excel 双击打开不乱码） */
export function 导出对照表(报告: 试跑报告, 成员们: readonly 成员[], b?: 业务): string {
  const 行: string[][] = [[...对照表头]];
  for (const e of 实体顺序) {
    const 列们 = 报告.映射.列[e];
    if (!列们?.length) continue;
    const 能填 = [...标准字段[e].map((f) => 字段中文[f] ?? f), 拼进(e), 不用].join("、");
    for (const c of 列们) 行.push(["列", 实体名[e], c.表头, c.字段名, 能填]);
  }
  for (const v of 报告.映射.值) {
    行.push([v.叫法, 实体名[值对照[v.名].实体], v.原值, v.我们的值, 合法值(v.名, b).map((x) => 值说法(v.名, x, b)).join("、")]);
  }
  const 人提示 = "成员名字或邮箱（重名的填邮箱）；空着 = 默认负责人";
  for (const p of 报告.映射.负责人) 行.push(["负责人", "", p.写法, 负责人写法(p.成员Id, 成员们), 人提示]);
  行.push(["默认负责人", "", "", 默认负责人写法(报告, 成员们), "对不上的负责人落到谁名下"]);
  return "﻿" + 行.map((r) => r.map(格).join(",")).join("\r\n") + "\r\n";
}

export type 读回结果 = {
  改: 映射改动;
  /** 改了几项（和报告当前不一样的） */
  改了: number;
  /** 认不出、填错的：哪一行、为什么。这些行不算，其余照改 */
  问题: string[];
};

/** 读回：CSV 或 xlsx（客户在 Excel 里另存了也行）。只收和报告当前不一样的，填错的行列进 问题 */
export function 读回对照表(文件: { 名: string; bytes: Uint8Array }, 报告: 试跑报告, 成员们: readonly 成员[], b?: 业务): 读回结果 {
  let rows: string[][];
  let 行号: number[];
  try {
    if (/\.xlsx$/i.test(文件.名)) {
      const t = 读xlsx各表(文件.bytes)[0];
      if (!t) throw new Error("表是空的");
      ({ rows, 行号 } = t);
    } else ({ rows, 行号 } = 解析CSV带行号(解码CSV(文件.bytes)));
  } catch (e) {
    throw new Error(`对照表读不出来：${e instanceof Error ? e.message : String(e)}`);
  }
  const 头 = (rows[0] ?? []).map(规整表头);
  const 位 = Object.fromEntries(对照表头.map((h) => [h, 头.indexOf(规整表头(h))])) as Record<(typeof 对照表头)[number], number>;
  if (位.类别 < 0 || 位.原系统写法 < 0 || 位.我们这边 < 0) throw new Error("对照表的表头不对：要有「类别」「原系统写法」「我们这边」三列，请用导出的那张填");

  const 改: 映射改动 = {};
  const 问题: string[] = [];
  let 改了 = 0;
  const 实体按名 = new Map(实体顺序.map((e) => [实体名[e], e]));
  const 值按叫法 = new Map((Object.keys(值对照) as 值对照名[]).map((k) => [值对照[k].叫法, k]));
  const 当前列 = (e: 实体, h: string) => 报告.映射.列[e]?.find((c) => c.表头 === h);

  const 认人 = (s: string): { id: string } | { 错: string } => {
    const k = s.trim();
    if (!k) return { id: "" };
    if (k.includes("@")) {
      const u = 成员们.find((x) => x.email?.toLowerCase() === k.toLowerCase());
      return u ? { id: u.id } : { 错: `找不到邮箱是「${k}」的成员` };
    }
    const 中 = 成员们.filter((x) => x.name.trim() === k);
    if (中.length === 1) return { id: 中[0].id };
    return { 错: 中.length ? `「${k}」有 ${中.length} 个同名成员，请填邮箱` : `找不到叫「${k}」的成员` };
  };

  rows.slice(1).forEach((r, i) => {
    const 第 = `第 ${行号[i + 1] ?? i + 2} 行`;
    const 取 = (h: (typeof 对照表头)[number]) => (位[h] >= 0 ? 去垫((r[位[h]] ?? "").trim()) : "");
    const 类别 = 取("类别"), 原 = 取("原系统写法"), 我们 = 取("我们这边");
    if (!类别 && !原 && !我们) return;

    if (类别 === "列") {
      const e = 实体按名.get(取("哪一类"));
      if (!e) return void 问题.push(`${第}：「哪一类」填的「${取("哪一类")}」认不出，要填 ${实体顺序.map((x) => 实体名[x]).join("、")} 之一`);
      const 现 = 当前列(e, 原);
      if (!现) return void 问题.push(`${第}：${实体名[e]}表里没有「${原}」这一列（列名别改，只改「我们这边」）`);
      let f: string | undefined;
      if (!我们 || 我们 === 不用 || 我们 === "不导") f = "";
      else if (我们 === 拼进(e) || 我们 === "拼进备注" || 我们 === "拼进内容") f = 进备注;
      else f = 标准字段[e].find((x) => 字段中文[x] === 我们 || x === 我们);
      if (f === undefined) return void 问题.push(`${第}：${实体名[e]}没有「${我们}」这个字段，看「能填的」那一格`);
      if (f === 现.字段) return;
      ((改.列 ??= {})[e] ??= {})[原] = f;
      改了++;
      return;
    }

    const 值名 = 值按叫法.get(类别);
    if (值名) {
      const 现 = 报告.映射.值.find((v) => v.名 === 值名 && v.原值 === 原);
      if (!现) return void 问题.push(`${第}：这次的数据里没有${类别}「${原}」（原系统写法别改）`);
      if (!我们 || 我们 === 现.我们的值) return;
      const to = 合法值(值名, b).find((x) => x === 我们 || 值说法(值名, x, b) === 我们);
      if (!to) return void 问题.push(`${第}：${类别}没有「${我们}」，要填 ${合法值(值名, b).map((x) => 值说法(值名, x, b)).join("、")} 之一`);
      ((改.值 ??= {})[值名] ??= {})[原] = to;
      改了++;
      return;
    }

    if (类别 === "负责人") {
      const 现 = 报告.映射.负责人.find((p) => p.写法 === 原);
      if (!现) return void 问题.push(`${第}：这次的数据里没有负责人「${原}」（原系统写法别改）`);
      // 和导出时写的一字不差 = 没动（成员已停用导出成空、重名没邮箱导出成名字，都不该算改了或报错）
      if (我们 === 负责人写法(现.成员Id, 成员们)) return;
      const 人 = 认人(我们);
      if ("错" in 人) return void 问题.push(`${第}：${人.错}`);
      if (人.id === 现.成员Id) return;
      (改.负责人 ??= {})[原] = 人.id;
      改了++;
      return;
    }

    if (类别 === "默认负责人") {
      if (我们 === 默认负责人写法(报告, 成员们)) return;
      const 人 = 认人(我们);
      if ("错" in 人) return void 问题.push(`${第}：${人.错}`);
      if (!人.id) return void 问题.push(`${第}：默认负责人不能空着`);
      if (人.id === 报告.映射.默认负责人.id) return;
      改.默认负责人Id = 人.id;
      改了++;
      return;
    }

    问题.push(`${第}：「类别」填的「${类别}」认不出`);
  });
  return { 改, 改了, 问题 };
}
