/**
 * 0.46.19（2026-10-17，AI 背调 + 外贸五件 + 团队版修补 + 接 Codex）：两边一样，不分平台；
 * 说人话：背调怎么开、扣几次、送一次、没跑完退；WhatsApp、完成计划顺手记一笔、等级、官网、对方当地时间；提醒团队都升级。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 切更新记录, 只留桌面端 } from "@/lib/changelog";

const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
const 这一版 = 全部.find((s) => s.版本 === "0.46.19")!;

it("最上面是 0.46.19，下面紧接 0.46.18", () => {
  expect(全部.slice(0, 2).map((s) => s.版本)).toEqual(["0.46.19", "0.46.18"]);
});

it("背调、外贸五件、团队版、Codex 都写了，Mac 和 Windows 一样", () => {
  const mac = 只留桌面端(这一版.正文, "darwin");
  const win = 只留桌面端(这一版.正文, "win32");
  expect(win).toBe(mac);
  for (const 词 of [
    "背调", "扣 1 次", "每个新账号送 1 次", "联系我们", "自动退回",
    "WhatsApp", "保存并完成", "跳过，直接完成", "撤销", "客户等级", "官网", "对方当地",
    "被同事后来的改动盖掉了", "都升级", "Codex",
  ]) expect(mac, `缺「${词}」`).toContain(词);
});

it("不写价格数字、不提网页版", () => {
  expect(这一版.正文).not.toMatch(/¥|\d+(\.\d+)?\s*元|网页版|托管版/);
});
