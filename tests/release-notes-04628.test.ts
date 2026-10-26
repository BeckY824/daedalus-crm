/**
 * 0.46.28（2026-10-24，团队同步不再卡住；团队版能分部门；排版）。
 * Mac 和 Windows 一样。项目模式开关默认关、还只在本机，这一版不写。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 切更新记录, 只留桌面端 } from "@/lib/changelog";

const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
const 这一版 = 全部.find((s) => s.版本 === "0.46.30")!;

it("最上面是 0.46.30（0.46.28、0.46.29 没发，并进这一段），下面紧接 0.46.27；不再有「下一版」", () => {
  expect(全部.slice(0, 2).map((s) => s.版本)).toEqual(["0.46.30", "0.46.27"]);
  expect(全部.map((s) => s.版本)).not.toContain("下一版");
});

it("同步不卡、立即同步、部门、虚线上级、按部门筛、跨部门撞号、我的反馈都写了，Mac 和 Windows 一样", () => {
  const mac = 只留桌面端(这一版.正文, "darwin");
  expect(只留桌面端(这一版.正文, "win32")).toBe(mac);
  for (const 词 of ["团队同步不再卡住", "立即同步", "部门", "虚线上级", "按部门筛", "别的部门", "我的反馈"]) expect(mac, `缺「${词}」`).toContain(词);
});

it("不写项目模式；不写版本号、价格数字，不提网页版", () => {
  expect(这一版.正文).not.toMatch(/项目模式|0\.46\.\d+|¥|\d+(\.\d+)?\s*元|网页版|托管版/);
});
