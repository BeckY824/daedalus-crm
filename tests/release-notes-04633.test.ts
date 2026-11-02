/**
 * 0.46.33（2026-11-02）：团队同步补丁——云端回复没收全不再删本机数据，升级后自动从云端完整补回一次。Mac 和 Windows 一样。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 切更新记录, 只留桌面端 } from "@/lib/changelog";

const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
const 这一版 = 全部.find((s) => s.版本 === "0.46.33")!;

it("最上面是 0.46.33，下面紧接 0.46.32；不再有「下一版」", () => {
  expect(全部.slice(0, 2).map((s) => s.版本)).toEqual(["0.46.33", "0.46.32"]);
  expect(全部.map((s) => s.版本)).not.toContain("下一版");
});

it("说清不再误删、自动补回、不用退团队，Mac 和 Windows 一样，正文不写版本号", () => {
  const mac = 只留桌面端(这一版.正文, "darwin");
  expect(只留桌面端(这一版.正文, "win32")).toBe(mac);
  for (const 词 of ["团队同步", "没收全", "自动", "补回来", "不用退团队"]) expect(mac, `缺「${词}」`).toContain(词);
  expect(这一版.正文).not.toMatch(/0\.46\.\d+/);
});
