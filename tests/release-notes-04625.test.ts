/**
 * 0.46.25（2026-10-21，客户页背调查公司；团队同步加固和提速；注册入口；阿里国际站 ID；上万条导入；阶段名可改）。
 * Mac 和 Windows 一样。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 切更新记录, 只留桌面端 } from "@/lib/changelog";

const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
const 这一版 = 全部.find((s) => s.版本 === "0.46.25")!;

it("0.46.25 下面紧接 0.46.24", () => {
  const 版本们 = 全部.map((s) => s.版本);
  const i = 版本们.indexOf("0.46.25");
  expect(版本们.slice(i, i + 2)).toEqual(["0.46.25", "0.46.24"]);
});

it("背调、同步、注册、阿里 ID、导入、阶段名都写了，Mac 和 Windows 一样", () => {
  const mac = 只留桌面端(这一版.正文, "darwin");
  expect(只留桌面端(这一版.正文, "win32")).toBe(mac);
  for (const 词 of ["背调", "公司", "同步", "20 人", "注册", "阿里国际站 ID", "一万行", "阶段", "升到这一版"]) expect(mac, `缺「${词}」`).toContain(词);
});

it("不写价格数字、不提网页版", () => {
  expect(这一版.正文).not.toMatch(/¥|\d+(\.\d+)?\s*元|网页版|托管版/);
});
