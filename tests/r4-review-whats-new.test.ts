/**
 * 第四轮对抗复查 · 桌面端「更新内容」（018a051）
 *
 * 红的保持红，等修。
 *   一、并成段 对真实 CHANGELOG：列表项折行写的续行（缩进两格）没并回列表项，渲染器把它当成一段独立的话，列表被拦腰切断
 *   二、升级判定：从 0.46.15 之前的版本**跳过 0.46.15** 直接升上来，0.46.15 那一大段看不到
 *   三、（绿，钉住）新装第一天导了表、第二天再开：不会被误认成升级
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
import { getSetting, invalidateSettingsCache } from "@/lib/settings";
import { 切更新记录, 只留桌面端, 并成段 } from "@/lib/changelog";
import { 有没有新内容, 看过了 } from "@/app/(app)/whats-new-actions";

const 仓库CHANGELOG = fs.readFileSync(path.resolve("CHANGELOG.md"), "utf8");

describe("并成段：真实 CHANGELOG 里的列表续行", () => {
  it("列表项折了一行（下一行缩进两格接着写）：应该并回这一条，不该变成列表外的一段", () => {
    const md = "- **Dock 图标上的数字**：今天到期和已经逾期的跟进。\n  和「跟进计划」页是同一个数，0 个就不显示。\n- 第二条";
    // 渲染器（components/Markdown）一行一判：缩进的续行不是列表行，于是 flush 掉列表、单独成一段，
    // 弹框里是「一条半句 / 一段半句 / 又一个新列表」
    expect(并成段(md)).toBe("- **Dock 图标上的数字**：今天到期和已经逾期的跟进。和「跟进计划」页是同一个数，0 个就不显示。\n- 第二条");
  });

  it("「更新记录」里能翻到的 30 版，处理完以后不该还有挂在列表项下面的缩进续行", () => {
    const 前30 = 切更新记录(仓库CHANGELOG).slice(0, 30);
    const 坏的: string[] = [];
    for (const s of 前30) {
      const 行 = 并成段(只留桌面端(s.正文)).split("\n");
      for (let i = 1; i < 行.length; i++) {
        if (/^\s+\S/.test(行[i]) && !/^\s*([-*+]|\d+[.)])\s/.test(行[i])) 坏的.push(`${s.版本}：${行[i].trim().slice(0, 20)}…`);
      }
    }
    // 0.46.6（Dock 数字 / 早报 / 到点提醒那三条）、0.43.0、0.40.0（导入五步）、0.39.1、0.39.0 都有
    expect(坏的, 坏的.join("\n")).toEqual([]);
  });
});

describe("升级判定", () => {
  const 原cwd = process.cwd();
  let 目录 = "";
  const MD = `# 更新记录

## 0.47.0（2026-11-01）

四十七

## 0.46.15（2026-10-14）

**大改的那一版**

## 0.46.14（2026-10-01）

十四
`;

  beforeEach(async () => {
    await resetDb();
    invalidateSettingsCache();
    mocks.本地 = true;
    目录 = fs.mkdtempSync(path.join(os.tmpdir(), "r4-whats-new-"));
    fs.writeFileSync(path.join(目录, "CHANGELOG.md"), MD);
    process.chdir(目录);
  });
  afterAll(async () => {
    process.chdir(原cwd);
    delete process.env.CRM_APP_VERSION;
    await prisma.$disconnect();
  });
  async function 建一位客户() {
    const u = await prisma.user.create({ data: { email: `a${Date.now()}@x`, name: "甲", title: "管理员", role: "ADMIN", password: "x" } });
    await prisma.customer.create({ data: { name: "客户", phone: "13800000001", salesOwnerId: u.id } });
  }

  it("（绿）新装第一天打开、导了表，第二天再开：不当成升级", async () => {
    process.env.CRM_APP_VERSION = "0.46.15";
    expect(await 有没有新内容()).toBeNull();
    await 建一位客户();
    invalidateSettingsCache();
    expect(await 有没有新内容()).toBeNull();
    expect(await getSetting("desktop.whatsNewSeen")).toBe("0.46.15");
  });

  it("从 0.46.14 跳过 0.46.15、直接升到 0.47.0：没有记录 = 一定是 0.46.15 之前来的，0.46.15 那段也该给", async () => {
    process.env.CRM_APP_VERSION = "0.47.0";
    await 建一位客户();
    const r = await 有没有新内容();
    // 一版一段原样给，版本号就是包的版本号
    expect(r?.版本).toBe("0.47.0");
    expect(r?.段.map((s) => s.版本)).toEqual(["0.47.0", "0.46.15"]);
    expect(r?.段[0].正文).toBe("四十七");
    expect(r?.段[1].正文).toContain("大改的那一版");
    await 看过了();
    expect(await getSetting("desktop.whatsNewSeen")).toBe("0.47.0");
    expect(await 有没有新内容()).toBeNull();
  });

  it("从 0.46.14 升到 0.46.15：只给 0.46.15 那一段，标题就是 0.46.15", async () => {
    process.env.CRM_APP_VERSION = "0.46.15";
    await 建一位客户();
    const r = await 有没有新内容();
    expect(r?.版本).toBe("0.46.15");
    expect(r?.段.map((s) => s.版本)).toEqual(["0.46.15"]);
    expect(r?.段[0].正文).not.toContain("十四");
  });

  it("测试人员装过更高的候选构建（记着看过 0.46.17）、再装回 0.46.15：不弹、不打转，记成看过 0.46.15", async () => {
    process.env.CRM_APP_VERSION = "0.46.17";
    await 建一位客户();
    await 看过了();
    process.env.CRM_APP_VERSION = "0.46.15";
    expect(await 有没有新内容()).toBeNull();
    expect(await getSetting("desktop.whatsNewSeen")).toBe("0.46.15");
    expect(await 有没有新内容()).toBeNull();
  });
});
