/**
 * 0.46.24（2026-10-21，登录页问不到云端时注册入口别丢；扫名片 AI 整理写进更新记录）。
 * Mac 和 Windows 一样。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 切更新记录, 只留桌面端 } from "@/lib/changelog";

const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
const 这一版 = 全部.find((s) => s.版本 === "0.46.24")!;

it("最上面是 0.46.24，下面紧接 0.46.23", () => {
  expect(全部.slice(0, 2).map((s) => s.版本)).toEqual(["0.46.24", "0.46.23"]);
});

it("注册入口、扫名片 AI 摆格子、外文配中文都写了，Mac 和 Windows 一样", () => {
  const mac = 只留桌面端(这一版.正文, "darwin");
  expect(只留桌面端(这一版.正文, "win32")).toBe(mac);
  for (const 词 of ["注册", "账号或密码不对", "继续", "扫名片", "配上中文", "不扣 AI 次数", "新建客户"]) expect(mac, `缺「${词}」`).toContain(词);
});

it("不写价格数字、不提网页版", () => {
  expect(这一版.正文).not.toMatch(/¥|\d+(\.\d+)?\s*元|网页版|托管版/);
});
