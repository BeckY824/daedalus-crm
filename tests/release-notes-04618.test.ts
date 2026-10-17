/**
 * 0.46.18（2026-10-16，新电脑带着老客户连团队）：两边一样，不分平台；
 * 说人话：备份是连之前原样的数据、分给示例账号（张三、李四）的客户归到业务员自己名下。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 切更新记录, 只留桌面端 } from "@/lib/changelog";

const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
const 这一版 = 全部.find((s) => s.版本 === "0.46.18")!;

it("0.46.18 下面紧接 0.46.17", () => {
  const 版本们 = 全部.map((s) => s.版本);
  const i = 版本们.indexOf("0.46.18");
  expect(版本们.slice(i, i + 2)).toEqual(["0.46.18", "0.46.17"]);
});

it("备份原样、示例账号的客户归到自己名下都写了，Mac 和 Windows 一样", () => {
  const mac = 只留桌面端(这一版.正文, "darwin");
  const win = 只留桌面端(这一版.正文, "win32");
  expect(win).toBe(mac);
  for (const 词 of ["备份", "连之前原样", "示例账号", "张三", "自己名下", "不会被清掉"]) expect(mac, `缺「${词}」`).toContain(词);
});

it("不写价格数字、不提网页版", () => {
  expect(这一版.正文).not.toMatch(/¥|\d+(\.\d+)?\s*元|网页版|托管版/);
});
