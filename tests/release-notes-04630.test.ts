/**
 * 0.46.30（2026-10-28：团队版免费、不标价；连不上云端时不吓人；长名字长来源不再挤乱排版）。Mac 和 Windows 一样。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 切更新记录, 只留桌面端 } from "@/lib/changelog";

const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
const 这一版 = 全部.find((s) => s.版本 === "0.46.30")!;

it("最上面是 0.46.30，下面紧接 0.46.29；不再有「下一版」", () => {
  expect(全部.slice(0, 2).map((s) => s.版本)).toEqual(["0.46.30", "0.46.29"]);
  expect(全部.map((s) => s.版本)).not.toContain("下一版");
});

it("团队版免费、续期、暂时查不到、排版都写了，Mac 和 Windows 一样", () => {
  const mac = 只留桌面端(这一版.正文, "darwin");
  expect(只留桌面端(这一版.正文, "win32")).toBe(mac);
  for (const 词 of ["团队版免费", "不再标价", "续期", "暂时查不到", "不再挤乱"]) expect(mac, `缺「${词}」`).toContain(词);
});

it("不写版本号、价格数字，不提网页版，也不再写「续费」", () => {
  expect(这一版.正文).not.toMatch(/0\.46\.\d+|¥|￥|\d+(\.\d+)?\s*元|网页版|托管版/);
  expect(这一版.正文).not.toMatch(/续费(?!」)/);
});
