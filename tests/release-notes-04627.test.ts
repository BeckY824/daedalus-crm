/**
 * 0.46.27（2026-10-23，商机、订单的产品图片；团队版升级后补同步；排版）。
 * Mac 和 Windows 一样。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 切更新记录, 只留桌面端 } from "@/lib/changelog";

const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
const 这一版 = 全部.find((s) => s.版本 === "0.46.27")!;

it("最上面是 0.46.27，下面紧接 0.46.26；不再有「下一版」", () => {
  expect(全部.slice(0, 2).map((s) => s.版本)).toEqual(["0.46.27", "0.46.26"]);
  expect(全部.map((s) => s.版本)).not.toContain("下一版");
});

it("产品图片、团队同步、手机、升级后补同步、管道、我的反馈都写了，Mac 和 Windows 一样", () => {
  const mac = 只留桌面端(这一版.正文, "darwin");
  expect(只留桌面端(这一版.正文, "win32")).toBe(mac);
  for (const 词 of ["产品图片", "跟着团队同步", "手机", "升级后", "商机管道", "我的反馈"]) expect(mac, `缺「${词}」`).toContain(词);
});

it("团队版不再写「只在传图的那台电脑上」；不写版本号、价格数字，不提网页版", () => {
  expect(这一版.正文).not.toMatch(/只在传图的那台电脑上|0\.46\.\d+|¥|\d+(\.\d+)?\s*元|网页版|托管版/);
});
