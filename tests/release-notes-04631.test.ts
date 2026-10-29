/**
 * 0.46.31（2026-10-29）：0.46.30 的补丁——开通团队后业务配置里马上有项目模式、公海、业务员能删，不用等同事加进来。Mac 和 Windows 一样。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 切更新记录, 只留桌面端 } from "@/lib/changelog";

const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
const 这一版 = 全部.find((s) => s.版本 === "0.46.31")!;

it("最上面是 0.46.31，下面紧接 0.46.30；不再有「下一版」", () => {
  expect(全部.slice(0, 2).map((s) => s.版本)).toEqual(["0.46.31", "0.46.30"]);
  expect(全部.map((s) => s.版本)).not.toContain("下一版");
});

it("写明是 0.46.30 的补丁，说清开通团队就有项目模式，Mac 和 Windows 一样", () => {
  const mac = 只留桌面端(这一版.正文, "darwin");
  expect(只留桌面端(这一版.正文, "win32")).toBe(mac);
  for (const 词 of ["0.46.30 的补丁", "开通团队", "项目模式", "公海", "业务员能删"]) expect(mac, `缺「${词}」`).toContain(词);
  // 除了补丁那行，不写别的版本号
  expect(这一版.正文.replace("0.46.30 的补丁", "")).not.toMatch(/0\.46\.\d+/);
});
