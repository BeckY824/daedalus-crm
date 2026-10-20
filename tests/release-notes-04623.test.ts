/**
 * 0.46.23（2026-10-20，团队版同事互看 + 公海分配、业务主管、疑似重复合并、扫名片相机没打开、减弱动态效果弹层）。
 * Mac 和 Windows 一样。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 切更新记录, 只留桌面端 } from "@/lib/changelog";

const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
const 这一版 = 全部.find((s) => s.版本 === "0.46.23")!;

it("最上面是 0.46.23，下面紧接 0.46.22", () => {
  expect(全部.slice(0, 2).map((s) => s.版本)).toEqual(["0.46.23", "0.46.22"]);
});

it("互看、公海分配、主管、合并、撤销、相机、从相册选、减弱动态都写了，Mac 和 Windows 一样", () => {
  const mac = 只留桌面端(这一版.正文, "darwin");
  expect(只留桌面端(这一版.正文, "win32")).toBe(mac);
  for (const 词 of [
    "同事之间互相看得到客户", "默认关", "收不回", "分配给…",
    "业务主管", "设为主管", "每台电脑都升到这一版",
    "疑似重复", "批量合并", "撤销一次", "合并前",
    "相机权限", "从相册选", "Edge", "Safari",
    "减弱动态效果",
  ]) expect(mac, `缺「${词}」`).toContain(词);
});

it("不写价格数字、不提网页版", () => {
  expect(这一版.正文).not.toMatch(/¥|\d+(\.\d+)?\s*元|网页版|托管版/);
});
