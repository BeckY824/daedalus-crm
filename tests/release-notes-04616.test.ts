/**
 * 0.46.16（2026-10-14，Windows 外观）：Windows 那一节只给 Windows；两边都不提网页版。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 切更新记录, 只留桌面端 } from "@/lib/changelog";

const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
const 这一版 = 全部.find((s) => s.版本 === "0.46.16")!;

it("最上面是 0.46.16，下面紧接 0.46.15", () => {
  expect(全部.slice(0, 2).map((s) => s.版本)).toEqual(["0.46.16", "0.46.15"]);
});

it("Windows 那一节只给 Windows，Mac 看不到", () => {
  const win = 只留桌面端(这一版.正文, "win32");
  const mac = 只留桌面端(这一版.正文, "darwin");
  for (const 词 of ["标题栏", "Segoe UI", "提示字"]) {
    expect(win).toContain(词);
    expect(mac).not.toContain(词);
  }
  for (const t of [win, mac]) expect(t).toContain("动画效果");
});

it("两边都不说「网页版」还在", () => {
  for (const 平台 of ["darwin", "win32"]) expect(只留桌面端(这一版.正文, 平台)).not.toMatch(/登录网页版|网页团队版|托管版/);
});
