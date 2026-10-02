"use server";

import fs from "node:fs/promises";
import path from "node:path";
import { requireUser } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/settings";
import { prisma } from "@/lib/prisma";
import { 本地模式 } from "@/lib/desktop/cloud";
import { 切更新记录, 这次新的, 只留桌面端, 并成段, type 一版 } from "@/lib/changelog";
import { version as 仓库版本 } from "../../../package.json";

/**
 * 桌面端「这一版更新了什么」（2026-10-02）。左栏账号那一行的「新」图标、账号菜单里的「更新记录」都从这儿取。
 *
 * 「刚更新过」= 现在的版本 ≠ 上次看过的版本。看过的版本记在这台机器的库里（Setting），
 * 不放 localStorage：本地服务每次启动换一个端口，页面的 origin 跟着变，localStorage 每次都是空的。
 * 第一次装好打开时没有记录：直接记成现在这一版、不提示——新用户不需要看「更新了什么」。
 * 但 0.46.15 之前的版本也没有这条记录：从老版本升上来、库里已经有客户或线索的，
 * 当成「刚从上一版升上来」，只给看现在这一版那一段。
 */
const 看过的键 = "desktop.whatsNewSeen";

function 现在的版本(): string {
  // 壳启动时写进环境变量（desktop/main.js），本地服务继承下来；开发时没有，用仓库里的
  return process.env.CRM_APP_VERSION || 仓库版本;
}

async function 读全部(): Promise<一版[]> {
  // 桌面端本地服务的 cwd 就是服务包目录，build-server.mjs 把 CHANGELOG.md 拷在那儿；开发时是仓库根
  try {
    return 切更新记录(await fs.readFile(path.join(process.cwd(), "CHANGELOG.md"), "utf8")).map((s) => ({
      ...s,
      正文: 并成段(只留桌面端(s.正文)),
    }));
  } catch {
    return [];
  }
}

/** 有没有该提示的。没有就回 null（网页版、第一次装、已经看过、更新记录里没有这一版） */
export async function 有没有新内容(): Promise<{ 版本: string; 段: 一版[] } | null> {
  await requireUser();
  if (!本地模式()) return null;
  const 现在 = 现在的版本();
  const 看过 = await getSetting<string>(看过的键);
  if (!看过) {
    // 有没有记录分不清「新装」和「从 0.46.15 之前升上来」，看库里有没有东西
    const 老库 = (await prisma.customer.count()) + (await prisma.lead.count()) > 0;
    const 这一版 = 老库 ? (await 读全部()).filter((s) => s.版本 === 现在) : [];
    if (!这一版.length) {
      await setSetting(看过的键, 现在);
      return null;
    }
    // 先不记：点了「知道了」才算看过，没点的话下次打开还在
    return { 版本: 现在, 段: 这一版 };
  }
  if (看过 === 现在) return null;
  const 段 = 这次新的(await 读全部(), 看过, 现在);
  if (!段.length) {
    // 更新记录里没写这几版（不该发生）：别挂一个点开是空的图标，直接记成看过
    await setSetting(看过的键, 现在);
    return null;
  }
  return { 版本: 现在, 段 };
}

/** 点了「知道了」 */
export async function 看过了(): Promise<void> {
  await requireUser();
  if (!本地模式()) return;
  await setSetting(看过的键, 现在的版本());
}

/** 账号菜单「更新记录」：最近 30 版，新的在前 */
export async function 全部更新记录(): Promise<{ 现在: string; 段: 一版[] }> {
  await requireUser();
  return { 现在: 现在的版本(), 段: (await 读全部()).slice(0, 30) };
}
