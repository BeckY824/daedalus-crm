/**
 * 0.46.20（2026-10-18，AI 背调 + 外贸五件 + 团队版修补 + 接 Codex + OpenAI 预设）：两边一样，不分平台；
 * 0.46.19 的 tag 构建没过（镜像类型检查、Windows 两个测试），没发出去，内容原样并进 0.46.20。
 * 说人话：背调怎么开、扣几次、送一次、没跑完退；WhatsApp、完成计划顺手记一笔、等级、官网、对方当地时间；提醒团队都升级。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 切更新记录, 只留桌面端 } from "@/lib/changelog";

const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
const 这一版 = 全部.find((s) => s.版本 === "0.46.20")!;

it("0.46.20 下面紧接 0.46.18（0.46.19 没发）", () => {
  const 版本们 = 全部.map((s) => s.版本);
  const i = 版本们.indexOf("0.46.20");
  expect(版本们.slice(i, i + 2)).toEqual(["0.46.20", "0.46.18"]);
});

it("背调、外贸五件、团队版、Codex、OpenAI 都写了，Mac 和 Windows 一样", () => {
  const mac = 只留桌面端(这一版.正文, "darwin");
  const win = 只留桌面端(这一版.正文, "win32");
  expect(win).toBe(mac);
  for (const 词 of [
    "背调", "扣 1 次", "每个新账号送 1 次", "联系我们", "自动退回",
    "WhatsApp", "保存并完成", "跳过，直接完成", "撤销", "客户等级", "官网", "对方当地",
    "被同事后来的改动盖掉了", "都升级", "Codex", "OpenAI（GPT）", "自己的 OpenAI Key",
  ]) expect(mac, `缺「${词}」`).toContain(词);
});

it("不写价格数字、不提网页版", () => {
  expect(这一版.正文).not.toMatch(/¥|\d+(\.\d+)?\s*元|网页版|托管版/);
});
