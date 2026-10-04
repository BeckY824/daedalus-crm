/**
 * 桌面端 e2e 的公用动作：壳不在，壳做的那几件事由这里代办。
 */
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { PrismaClient } from "../src/generated/prisma";
import { CLOUD_URL, DATA_DIR, DB, DESKTOP_TOKEN, 云端账号, 进门地址 } from "./env";

export function 连库() {
  return new PrismaClient({ datasourceUrl: `file:${DB}` });
}

/**
 * 壳启动时那一下：带着令牌敲 /api/desktop/session，换一张会话票据再落到 next 指的那页。
 * 等的是「落到了应用里」而不是某个固定地址：新库会先去 /start 选模版。
 */
export async function 进门(page: Page, next?: string) {
  await page.goto(进门地址(next));
  await expect(page).not.toHaveURL(/\/login|\/api\/desktop/);
  // dev 模式下页面要先水合，点得太早会落空（默认 e2e 的老问题）
  await page.waitForLoadState("networkidle").catch(() => {});
}

/** 本机我（管理员）——prepare.ts 已经把他对成了云端账号 */
export async function 我的id(db: PrismaClient): Promise<string> {
  return (await db.user.findFirstOrThrow({ where: { email: 云端账号.contact } })).id;
}

const 凭据 = path.join(DATA_DIR, ".cloud.json");
const 藏起来 = `${凭据}.e2e-away`;

/**
 * 模拟「退出了云端账号 / 令牌被吊销后壳清掉了」：把 .cloud.json 挪开，fn 跑完一定挪回来。
 * 挪而不删：放回去的还是原来那份，后面的用例不受影响。
 */
export async function 没登录云端时<T>(fn: () => Promise<T>): Promise<T> {
  renameSync(凭据, 藏起来);
  try {
    return await fn();
  } finally {
    if (existsSync(藏起来)) renameSync(藏起来, 凭据);
  }
}

/** 壳每分钟问的那一下 */
export async function 问提醒(page: Page, 令牌: string | null = DESKTOP_TOKEN) {
  return page.request.get("/api/desktop/reminders", { headers: 令牌 ? { "x-desktop-token": 令牌 } : {} });
}

/** 假云端各路径被叫了几次（e2e-desktop/cloud-stub.mjs） */
export async function 云端统计(page: Page): Promise<Record<string, number>> {
  return (await page.request.get(`${CLOUD_URL}/__stub/stats`)).json();
}

/** 假云端那份「中转的成员名单」。beforeAll 里没有 page，所以收 request */
export async function 设云端团队(request: APIRequestContext, 团队: unknown) {
  expect((await request.post(`${CLOUD_URL}/__stub/team`, { data: 团队 })).ok()).toBe(true);
}

/** 收集一页的控制台 error / warning 和页面异常 */
export function 盯控制台(page: Page) {
  const 问题: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") 问题.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => 问题.push(`[pageerror] ${e.message.slice(0, 300)}`));
  return 问题;
}
