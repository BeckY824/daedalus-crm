/**
 * 文件太大先挡住、读不出来说人话（2026-10-21 总控问「一次导多少会崩」，量的数见 #76）：
 *   - 1 万行以内的正常表（9 列 CSV 约 3 MB，30 列长备注 46 MB）都放行
 *   - 过了线直接说「这个文件有 N MB，太大了」和怎么拆，不往页面里读
 *   - 浏览器抛的英文错（内存不够、字符串太长）换成人话；我们自己的中文错照说
 */
import { it, expect } from "vitest";
import { 文件太大, 文件大小上限, 读不出来的话 } from "@/lib/import/parse";

const MB = 1024 * 1024;

it("1 万行以内的正常表都放行：9 列 3 MB、30 列长备注 46 MB 的 CSV，xlsx 几 MB", () => {
  expect(文件太大("一万条.csv", 3 * MB)).toBeNull();
  expect(文件太大("三十列.csv", 47 * MB)).toBeNull();
  expect(文件太大("一万条.xlsx", 5 * MB)).toBeNull();
  expect(文件太大("刚好.csv", 文件大小上限.csv)).toBeNull();
});

it("过了线：说多大、一次最多 1 万行、怎么拆；xlsx 的线比 CSV 低（压过）", () => {
  const 话 = 文件太大("客户全量.csv", 文件大小上限.csv + 1);
  expect(话).toMatch(/^这个文件有 \d+ MB，太大了，读不进来。一次最多导 10,000 行/);
  expect(话).toContain("每份 1 万行以内");
  expect(文件太大("客户全量.XLSX", 文件大小上限.xlsx + 1)).toContain("太大了");
  expect(文件太大("客户全量.csv", 文件大小上限.xlsx + 1)).toBeNull();
});

it("读不出来：英文错换成人话，中文错照说", () => {
  expect(读不出来的话(new RangeError("Invalid string length"))).toMatch(/^这个文件读不出来：可能太大或者坏了/);
  expect(读不出来的话(new Error("Array buffer allocation failed"))).not.toMatch(/[A-Za-z]{6,}/);
  expect(读不出来的话("oops")).toContain("读不出来");
  expect(读不出来的话(new Error("这个 xlsx 里找不到工作表"))).toBe("这个 xlsx 里找不到工作表");
});
