/**
 * 0.46.29（2026-10-27：跟进渠道可以自己定，D-48）。Mac 和 Windows 一样。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 切更新记录, 只留桌面端 } from "@/lib/changelog";

const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
const 这一版 = 全部.find((s) => s.版本 === "0.46.29")!;

it("最上面是 0.46.29，下面紧接 0.46.28；不再有「下一版」", () => {
  expect(全部.slice(0, 2).map((s) => s.版本)).toEqual(["0.46.29", "0.46.28"]);
  expect(全部.map((s) => s.版本)).not.toContain("下一版");
});

it("改名、关掉、自己加、同步给全队、老记录照旧都写了，Mac 和 Windows 一样", () => {
  const mac = 只留桌面端(这一版.正文, "darwin");
  expect(只留桌面端(这一版.正文, "win32")).toBe(mac);
  for (const 词 of ["跟进渠道", "改名", "关掉", "自己加", "同步给全队", "照旧显示"]) expect(mac, `缺「${词}」`).toContain(词);
});

it("不写版本号、价格数字，不提网页版", () => {
  expect(这一版.正文).not.toMatch(/0\.46\.\d+|¥|\d+(\.\d+)?\s*元|网页版|托管版/);
});
