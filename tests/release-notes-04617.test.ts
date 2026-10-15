/**
 * 0.46.17（2026-10-15，团队版手机端、多设备、按时长开通）：两边一样，不分平台；
 * 不写价格数字（价格在「设置 → 团队」里从服务器读），不提网页版。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 切更新记录, 只留桌面端 } from "@/lib/changelog";

const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
const 这一版 = 全部.find((s) => s.版本 === "0.46.17")!;

it("最上面是 0.46.17，下面紧接 0.46.16", () => {
  expect(全部.slice(0, 2).map((s) => s.版本)).toEqual(["0.46.17", "0.46.16"]);
});

it("手机端、多设备、按时长开通都写了，Mac 和 Windows 一样", () => {
  const mac = 只留桌面端(这一版.正文, "darwin");
  const win = 只留桌面端(这一版.正文, "win32");
  expect(win).toBe(mac);
  for (const 词 of ["手机", "配对数字", "允许", "我的设备", "最多 3 台", "打开就弹出一串配对数字", "以后再说", "旧邀请码作废", "不会再被换回注册时", "有效期", "到期后暂停同步", "续费后自动恢复"]) expect(mac, `缺「${词}」`).toContain(词);
});

it("不写价格数字、不提网页版", () => {
  expect(这一版.正文).not.toMatch(/¥|\d+(\.\d+)?\s*元|网页版|托管版/);
});
