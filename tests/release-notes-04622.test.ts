/**
 * 0.46.22（2026-10-19，团队版扫名片、同事查重 / 公海 / 席位、应用内收反馈回复、录入更稳、排版）。
 * 「最小化到托盘」只给 Windows，其余 Mac 和 Windows 一样。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 切更新记录, 只留桌面端 } from "@/lib/changelog";

const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
const 这一版 = 全部.find((s) => s.版本 === "0.46.22")!;

it("0.46.22 下面紧接 0.46.21", () => {
  const 版本们 = 全部.map((s) => s.版本);
  const i = 版本们.indexOf("0.46.22");
  expect(版本们.slice(i, i + 2)).toEqual(["0.46.22", "0.46.21"]);
});

it("扫名片、查重、公海、席位、反馈回复、微信、商机名称框、草稿都写了", () => {
  const mac = 只留桌面端(这一版.正文, "darwin");
  for (const 词 of [
    "扫名片", "再扫一张", "不上传、不保存", "不扣 AI 次数",
    "同事名下", "领取并记跟进", "团队人数已满", "手机伴侣只给团队版", "没同步上",
    "我的反馈", "接着说", "小红点",
    "微信沟通", "商机名称框", "草稿",
  ]) expect(mac, `缺「${词}」`).toContain(词);
});

it("托盘只给 Windows", () => {
  expect(只留桌面端(这一版.正文, "win32")).toContain("最小化到托盘");
  expect(只留桌面端(这一版.正文, "darwin")).not.toContain("托盘");
});

it("不写价格数字、不提网页版", () => {
  expect(这一版.正文).not.toMatch(/¥|\d+(\.\d+)?\s*元|网页版|托管版/);
});
