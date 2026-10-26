/**
 * 0.46.15 的更新内容（2026-10-14 定稿）：CHANGELOG 里只有一段 0.46.15，测试期间的候选构建都并进了这一段。
 * 钉住这一段里用户看得到的几件大事都写了、不提网页版和内部构建号、Windows 的那几条只给 Windows。
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 切更新记录, 只留桌面端 } from "@/lib/changelog";

const md = fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8");
const 全部 = 切更新记录(md);
const 这一版 = 全部.find((s) => s.版本 === "0.46.15")!;
const 给 = (平台: string) => 只留桌面端(这一版.正文, 平台);

it("0.46.15 只有一段，紧接 0.46.14：测试期间的候选版本（内部构建 0.46.16 / 0.46.17）都并进了这一段", () => {
  const 版本们 = 全部.map((s) => s.版本);
  const i = 版本们.indexOf("0.46.15");
  expect(版本们.slice(i, i + 2)).toEqual(["0.46.15", "0.46.14"]);
  expect(全部.filter((s) => s.版本 === "0.46.15")).toHaveLength(1);
  // 0.46.16 起是正式的新版本（2026-10-14 Windows 外观），不再是候选构建号；0.46.17（2026-10-15 手机端、多设备）、
  // 0.46.18（2026-10-16 新电脑带老客户连团队）、0.46.20（2026-10-18 背调、外贸五件、OpenAI；0.46.19 构建没过、没发，内容并进 0.46.20）、0.46.21（2026-10-19 背调补充）、0.46.22（2026-10-19 扫名片、团队查重、反馈回复）、0.46.23（2026-10-20 团队互看、业务主管、合并重复）、0.46.24（2026-10-21 注册入口）、0.46.25（2026-10-21 背调查公司、团队同步、阿里 ID、上万条导入、阶段名）、0.46.26（2026-10-22 提速、安装包瘦身）、0.46.27（2026-10-23 产品图片、升级后补同步、排版）、0.46.28、0.46.29（都没发，并进 0.46.30）、0.46.30（2026-10-26 团队同步不卡、部门、提速）只该是它们自己那一节的标题
  expect(md.replace(/^## 0\.46\.(1[78]|2[0-9]|30)（[^）]*）$/gm, "")).not.toMatch(/0\.46\.(1[7-9]|[23]\d)/);
});

it("0.46.15 写全了用户看得到的大事", () => {
  for (const 平台 of ["darwin", "win32"]) {
    const t = 给(平台);
    for (const 词 of ["我的客户", "团队客户", "公海", "业务员的电脑只存自己的客户和公海", "领取", "交给同事", "两台电脑", "毛玻璃", "团队同步", "外贸", "币种", "自动备份"]) expect(t, `${平台} 缺「${词}」`).toContain(词);
    expect(t).not.toMatch(/网页版|网页团队版|共享试用区|CRM_SCOPED_SYNC|环境变量|内部构建|候选构建|构建号/);
  }
  const win = 给("win32"), mac = 给("darwin");
  expect(win).toContain("系统通知（到点提醒等）点一下就打开对应的那条");
  expect(win).toContain("端口被系统占用或保留时自动换一个");
  expect(win).toContain("关了窗口没关系");
  expect(mac).not.toContain("端口被系统占用");
  expect(mac).not.toContain("关了窗口没关系");
  expect(mac).not.toContain("**Windows**");
});

it("同一件事只说一次", () => {
  const 要点 = 这一版.正文.split("\n").filter((l) => /^- /.test(l)).map((l) => l.trim());
  expect(要点.filter((l, i) => 要点.indexOf(l) !== i)).toEqual([]);
  for (const 句 of ["领取公海客户后", "把客户交给同事", "账号被停用后", "签约、订单的日期填错"]) {
    expect(这一版.正文.split(句).length - 1, 句).toBe(1);
  }
});
