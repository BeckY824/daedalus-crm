/**
 * 0.46.21（2026-10-19，AI 背调补充：真实性程序直查、A+D 报告结构、名字 + 电话找公司、简版不扣）：两边一样，不分平台。
 * 说人话：真实性红黄绿灯不进分数；报告结论先行、已核实；必查四项；同行最多 40 分先问外不外采；名字 + 电话；扣次规则。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 切更新记录, 只留桌面端 } from "@/lib/changelog";

const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
const 这一版 = 全部.find((s) => s.版本 === "0.46.21")!;

it("最上面是 0.46.21，下面紧接 0.46.20", () => {
  expect(全部.slice(0, 2).map((s) => s.版本)).toEqual(["0.46.21", "0.46.20"]);
});

it("真实性、新结构、必查四项、名字 + 电话、扣次都写了，Mac 和 Windows 一样", () => {
  const mac = 只留桌面端(这一版.正文, "darwin");
  const win = 只留桌面端(这一版.正文, "win32");
  expect(win).toBe(mac);
  for (const 词 of [
    "真实性", "红黄绿灯", "不算进相关性分数", "制裁名单", "进口记录",
    "已核实", "关键发现", "认证提醒", "母公司", "外不外采", "英文开发信",
    "只有名字和电话", "虚构号码", "询盘邮件", "信息少，谨慎",
    "开始搜索后扣 1 次", "只出了简版（没认出公司）不扣", "照旧退回",
  ]) expect(mac, `缺「${词}」`).toContain(词);
});

it("不写价格数字、不提网页版", () => {
  expect(这一版.正文).not.toMatch(/¥|\d+(\.\d+)?\s*元|网页版|托管版/);
});
