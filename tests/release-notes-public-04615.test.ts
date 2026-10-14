/**
 * 公开版 0.46.15 的更新内容（2026-10-14 候选 9）：内部构建 0.46.16 起都显示成 0.46.15（desktop/release-version.js），
 * 更新内容按 displayReleaseNotes 并成一段。钉住这一段里用户看得到的几件大事都写了、网页版不提、Windows 的那几条只给 Windows。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { 切更新记录, 只留桌面端, 比版本 } from "@/lib/changelog";

const { displayReleaseNotes } = createRequire(import.meta.url)("../desktop/release-version.js");
const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
const 公开版 = (平台: string) => {
  const 段 = displayReleaseNotes(全部.filter((s) => 比版本(s.版本, "0.46.15") >= 0).map((s) => ({ ...s, 正文: 只留桌面端(s.正文, 平台) })));
  expect(段.map((s: { 版本: string }) => s.版本)).toEqual(["0.46.15"]);
  return 段[0].正文 as string;
};

it("公开版 0.46.15 写全了这一串候选里用户看得到的大事", () => {
  for (const 平台 of ["darwin", "win32"]) {
    const t = 公开版(平台);
    for (const 词 of ["我的客户", "团队客户", "公海", "业务员的电脑只存自己的客户和公海", "领取", "交给同事", "两台电脑", "毛玻璃", "团队同步"]) expect(t, `${平台} 缺「${词}」`).toContain(词);
    expect(t).not.toMatch(/网页版|CRM_SCOPED_SYNC|环境变量/);
  }
  const win = 公开版("win32"), mac = 公开版("darwin");
  expect(win).toContain("系统通知（到点提醒等）点一下就打开对应的那条");
  expect(win).toContain("端口被系统占用或保留时自动换一个");
  expect(mac).not.toContain("端口被系统占用");
  expect(mac).not.toContain("**Windows**");
});
