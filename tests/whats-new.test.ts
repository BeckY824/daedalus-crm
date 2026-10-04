/**
 * 桌面端「这一版更新了什么」（2026-10-02）：切 CHANGELOG、什么时候该挂那枚「新」。
 * 钉的几条：第一次装不提示；从 0.46.15 之前升上来（没有「看过」记录、库里有东西）要提示这一版；
 * 跳了几版都列出来；看过就收；网页团队版那一小节桌面端不给看。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({ 本地: true }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "u", name: "甲", role: "ADMIN" }) }));
vi.mock("@/lib/desktop/cloud", () => ({ 本地模式: () => mocks.本地 }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { getSetting, setSetting, invalidateSettingsCache } from "@/lib/settings";
import { 切更新记录, 这次新的, 比版本, 只留桌面端, 并成段 } from "@/lib/changelog";
import { 有没有新内容, 看过了, 全部更新记录 } from "@/app/(app)/whats-new-actions";

const MD = `# 更新记录

开头的说明。

## 0.46.15（2026-10-04）

**新的**

- 一条

### 网页团队版另外

- 同事那条

## 0.46.14 (2026-10-01)

十四

## v0.46.13（2026-09-29）

十三

## 说明

不属于任何一版
`;

describe("切更新记录", () => {
  it("全角半角括号、v 前缀都认；非版本的二级标题截断；开头说明不算", () => {
    const 段 = 切更新记录(MD);
    expect(段.map((s) => [s.版本, s.日期])).toEqual([
      ["0.46.15", "2026-10-04"],
      ["0.46.14", "2026-10-01"],
      ["0.46.13", "2026-09-29"],
    ]);
    expect(段[2].正文).toBe("十三");
  });
  it("跳了几版：从看过的（不含）到现在的（含），新的在前", () => {
    expect(这次新的(切更新记录(MD), "0.46.13", "0.46.15").map((s) => s.版本)).toEqual(["0.46.15", "0.46.14"]);
    expect(比版本("0.46.15", "0.46.9")).toBeGreaterThan(0);
  });
  it("桌面端去掉「网页团队版」那一小节，别的留着", () => {
    const 正文 = 只留桌面端(切更新记录(MD)[0].正文);
    expect(正文).toContain("一条");
    expect(正文).not.toContain("同事那条");
    expect(正文).not.toContain("网页团队版");
  });
});

describe("并成段", () => {
  it("折行写的一段并成一行；加粗小标题、列表、空行不并", () => {
    const md = "**标题**\n\n第一行，\n第二行。\n\n- 一条\n- 两条\n接着写";
    expect(并成段(md)).toBe("**标题**\n\n第一行，第二行。\n\n- 一条\n- 两条\n接着写");
  });
});

describe("有没有新内容", () => {
  const 原cwd = process.cwd();
  let 目录 = "";

  beforeEach(async () => {
    await resetDb();
    invalidateSettingsCache(); // 设置有进程内缓存，清库不清它
    mocks.本地 = true;
    process.env.CRM_APP_VERSION = "0.46.15";
    目录 = fs.mkdtempSync(path.join(os.tmpdir(), "whats-new-"));
    fs.writeFileSync(path.join(目录, "CHANGELOG.md"), MD);
    process.chdir(目录);
  });
  async function 建一位老客户() {
    const u = await prisma.user.create({ data: { email: "a@x", name: "甲", title: "管理员", role: "ADMIN", password: "x" } });
    await prisma.customer.create({ data: { name: "老客户", phone: "13800000001", salesOwnerId: u.id } });
  }
  afterAll(async () => {
    process.chdir(原cwd);
    delete process.env.CRM_APP_VERSION;
    await prisma.$disconnect();
  });

  it("第一次装（空库、没有记录）：不提示，记成现在这一版", async () => {
    expect(await 有没有新内容()).toBeNull();
    expect(await getSetting("desktop.whatsNewSeen")).toBe("0.46.15");
  });

  it("从 0.46.15 之前升上来（没有记录、库里有客户）：只给这一版，点了才算看过", async () => {
    await 建一位老客户();
    const r = await 有没有新内容();
    expect(r?.段.map((s) => s.版本)).toEqual(["0.46.15"]);
    expect(r?.段[0].正文).not.toContain("同事那条");
    expect(await getSetting("desktop.whatsNewSeen")).toBeNull();
    expect((await 有没有新内容())?.版本).toBe("0.46.15");
    await 看过了();
    expect(await 有没有新内容()).toBeNull();
  });

  it("看过 0.46.13、跳到 0.46.15：列出两版", async () => {
    await setSetting("desktop.whatsNewSeen", "0.46.13");
    expect((await 有没有新内容())?.段.map((s) => s.版本)).toEqual(["0.46.15", "0.46.14"]);
  });

  it("看过就是现在这版：不提示", async () => {
    await setSetting("desktop.whatsNewSeen", "0.46.15");
    expect(await 有没有新内容()).toBeNull();
  });

  it("网页版：什么都不给", async () => {
    mocks.本地 = false;
    await 建一位老客户();
    expect(await 有没有新内容()).toBeNull();
  });

  it("更新记录里没有 CHANGELOG（读不到）：不挂空图标，全部也是空的", async () => {
    fs.rmSync(path.join(目录, "CHANGELOG.md"));
    await setSetting("desktop.whatsNewSeen", "0.46.13");
    expect(await 有没有新内容()).toBeNull();
    expect((await 全部更新记录()).段).toEqual([]);
    // 读不到不等于「没写这一版」：不能记成看过，文件回来了下次照样弹（2026-10-04 实机）
    expect(await getSetting("desktop.whatsNewSeen")).toBe("0.46.13");
    fs.writeFileSync(path.join(目录, "CHANGELOG.md"), MD);
    expect((await 有没有新内容())?.段.map((s) => s.版本)).toEqual(["0.46.15", "0.46.14"]);
  });

  it("老库升上来时读不到 CHANGELOG：也不记，下次再说", async () => {
    await 建一位老客户();
    fs.rmSync(path.join(目录, "CHANGELOG.md"));
    expect(await 有没有新内容()).toBeNull();
    expect(await getSetting("desktop.whatsNewSeen")).toBeNull();
  });
});

describe("分节：弹窗里一节一张卡", () => {
  it("按单独成行的「**标题**」切；标题前的开场白算一节没标题的；行内加粗不切", async () => {
    const { 分节 } = await import("@/lib/changelog");
    expect(分节("开场一句\n\n**换了新样子**\n\n- 毛玻璃\n- 左栏\n\n**团队同步**\n\n几个人 **加密** 同步")).toEqual([
      { 标题: "", 正文: "开场一句" },
      { 标题: "换了新样子", 正文: "- 毛玻璃\n- 左栏" },
      { 标题: "团队同步", 正文: "几个人 **加密** 同步" },
    ]);
    expect(分节("只有一段话")).toEqual([{ 标题: "", 正文: "只有一段话" }]);
    expect(分节("")).toEqual([]);
  });

  it("真实 CHANGELOG 的 0.46.15：每节都有标题、有内容", async () => {
    const fs = await import("node:fs");
    const { 切更新记录, 分节, 只留桌面端, 并成段 } = await import("@/lib/changelog");
    const 这版 = 切更新记录(fs.readFileSync("CHANGELOG.md", "utf8")).find((s) => s.版本 === "0.46.15")!;
    const 节们 = 分节(并成段(只留桌面端(这版.正文)));
    expect(节们.length).toBeGreaterThan(10);
    for (const 节 of 节们) {
      expect(节.标题, JSON.stringify(节).slice(0, 80)).not.toBe("");
      expect(节.正文.length).toBeGreaterThan(0);
    }
    expect(节们.map((x) => x.标题)).toContain("几个人一起用：团队同步");
  });
});

/*
  【下一版】回归核对 R-076：应用内「更新内容」读 CHANGELOG，只去掉「网页团队版」小节，不按平台过滤——
  Windows 用户也看到 ⌘K、Dock、访达这些 Mac 才有的说法，像装错了版本。官网 feed 那份 win32 notes 在官网仓库（不归这里）。
  修法待定（CHANGELOG 约定「（仅 Mac）」行、只留桌面端 按平台去掉），修了去掉 skip
*/
describe("更新内容按平台说话（R-076）", () => {
  it.skip("【下一版】Windows 上看到的这一版说明里没有 Mac 专属的说法", () => {
    const 全部 = 切更新记录(fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"));
    const 给Windows = (只留桌面端 as unknown as (正文: string, 平台: string) => string)(全部[0].正文, "win32");
    expect(给Windows).not.toMatch(/Dock|访达|⌘/);
  });
});
