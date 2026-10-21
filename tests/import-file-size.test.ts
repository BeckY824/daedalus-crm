/**
 * 文件太大先挡住、读不出来说人话（2026-10-21 总控问「一次导多少会崩」，量的数见 #76）：
 *   - 1 万行以内的正常表（9 列 CSV 约 3 MB，30 列长备注 46 MB）都放行
 *   - 过了线直接说「这个文件有 N MB，太大了」和怎么拆，不往页面里读
 *   - 浏览器抛的英文错（内存不够、字符串太长）换成人话；我们自己的中文错照说
 *   - xlsx 不按文件大小挡（多半是贴的图）：图片不解压，看工作表解开多大（10-21 质量审 #76）
 *   - 超过上限只导了前一截，确认、导完了两步都要说
 */
import { it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { unzipSync, zipSync } from "fflate";
import { 文件太大, 文件大小上限, 读不出来的话, 只导了前面的话 } from "@/lib/import/parse";
import { 读xlsx带行号, 读不出来 } from "@/lib/import/xlsx";
import { 写xlsx } from "@/lib/xlsx-write";

const MB = 1024 * 1024;

it("1 万行以内的正常表都放行：9 列 3 MB、30 列长备注 46 MB 的 CSV，xlsx 几 MB", () => {
  expect(文件太大("一万条.csv", 3 * MB)).toBeNull();
  expect(文件太大("三十列.csv", 47 * MB)).toBeNull();
  expect(文件太大("一万条.xlsx", 5 * MB)).toBeNull();
  expect(文件太大("刚好.csv", 文件大小上限.csv)).toBeNull();
});

it("过了线：说多大、一次最多 1 万行、怎么拆", () => {
  const 话 = 文件太大("客户全量.csv", 文件大小上限.csv + 1);
  expect(话).toMatch(/^这个文件有 \d+ MB，太大了，读不进来。一次最多导 10,000 行/);
  expect(话).toContain("每份 1 万行以内");
});

it("xlsx 不按 CSV 的线挡：贴了图的表常见；真大到读不进内存时说删图或另存 CSV，不叫人拆行", () => {
  expect(文件太大("带图.xlsx", 40 * MB)).toBeNull();
  expect(文件太大("带图.xlsx", 文件大小上限.csv + 1)).toBeNull();
  const 话 = 文件太大("客户全量.XLSX", 文件大小上限.xlsx + 1)!;
  expect(话).toContain("太大了");
  expect(话).toContain("图片");
  expect(话).not.toContain("1 万行");
});

/** 200 行的外贸表，再塞一张 40 MB 的「图」（随机字节，压不小），存成和 Excel 一样的 xl/media/ */
function 带图的表(图大小: number) {
  const 表 = 写xlsx([{ 名: "客户", 表头: ["姓名", "手机号"], 行: Array.from({ length: 200 }, (_, i) => [`客户${i}`, `139${String(i).padStart(8, "0")}`]) }]);
  const 文件们 = unzipSync(表);
  文件们["xl/media/image1.png"] = randomBytes(图大小);
  return zipSync(文件们, { level: 0 });
}

it("200 行带 40 MB 图片的 xlsx：放行，200 行全读到，图片不解压", () => {
  const 字节 = 带图的表(40 * MB);
  expect(字节.length).toBeGreaterThan(40 * MB);
  expect(文件太大("带图.xlsx", 字节.length)).toBeNull();
  const t0 = Date.now();
  const { rows } = 读xlsx带行号(字节);
  expect(rows).toHaveLength(201);
  expect(rows[200]).toEqual(["客户199", "13900000199"]);
  expect(Date.now() - t0).toBeLessThan(2000);
});

it("工作表解开太大：中文说读不动、怎么拆；不当成「打不开、是不是 .xls」", () => {
  const 字节 = 带图的表(1024);
  // 线调小到这张表的工作表放不下，量的是解开后的大小，不是文件多大
  expect(() => 读xlsx带行号(字节, 1000)).toThrow(读不出来);
  expect(() => 读xlsx带行号(字节, 1000)).toThrow(/^这张表内容太多，读不动（解开有 \d+ MB）。一次最多导 10,000 行：请在 Excel 里拆成几份、每份 1 万行以内/);
  expect(读xlsx带行号(字节).rows).toHaveLength(201);
});

it("只导了前一截：按实际留下的条数说（文件 1 万、粘贴 200），没截就不说", () => {
  expect(只导了前面的话(undefined)).toBeNull();
  expect(只导了前面的话({})).toBeNull();
  expect(只导了前面的话({ 行: 12000 }, 10000)).toBe("这张表超过 10,000 条，只读了前 10,000 条，第 10,001 条起没读进来、这一批里没有它们；请把剩下的另存一份再导。");
  expect(只导了前面的话({ 行: 300 }, 200)).toContain("超过 200 条，只读了前 200 条，第 201 条起");
  expect(只导了前面的话({ 列: 60 })).toBe("超过 50 列，第 51 列起没读进来。");
});

it("读不出来：英文错换成人话，中文错照说", () => {
  expect(读不出来的话(new RangeError("Invalid string length"))).toMatch(/^这个文件读不出来：可能太大或者坏了/);
  expect(读不出来的话(new Error("Array buffer allocation failed"))).not.toMatch(/[A-Za-z]{6,}/);
  expect(读不出来的话("oops")).toContain("读不出来");
  expect(读不出来的话(new Error("这个 xlsx 里找不到工作表"))).toBe("这个 xlsx 里找不到工作表");
});
