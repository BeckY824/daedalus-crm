/**
 * 排版闸门：「我的反馈」页 + 左下角回复提示（应用内收回复，2026-10-19）。
 *
 * 数据照最难排的样子放（假云端 /__stub/feedback）：一大段带空行的长回复、一条两百多字符的长链接、没有空格的一长串订单号、
 * 阿拉伯文（从右往左）、emoji（含肤色、家庭这种多码点的）、只有一句没回复的、发送失败待重发的不在这里（那是交互，见 e2e-desktop/12）。
 * 宽度和摆法同 排版闸门.spec.ts：1024 / 1280 / 1366 × 默认 / AI 栏常驻 / 左栏最宽；1024 开着 AI 栏时这一页是窄的（一栏）。
 *
 *   E2E_PORT=3520 npx playwright test -c playwright.layout.config.ts e2e-layout/我的反馈.spec.ts
 *   E2E_SHOT_DIR=… 时每屏都截一张（不只是有问题的）
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { 进门 } from "../e2e-desktop/helpers";
import { CLOUD_URL, DATA_DIR } from "../e2e-desktop/env";
import { 查排版, 说问题 } from "../e2e/layout-audit";

test.describe.configure({ mode: "serial" });

const 出处 = process.env.E2E_SHOT_DIR ? path.join(process.env.E2E_SHOT_DIR, "我的反馈") : null;
const 忽略 = [".ant-message", ".ant-notification", "nextjs-portal"];

const 时 = (d: number, h = 9) => new Date(Date.UTC(2026, 9, d, h, 12)).toISOString();
const 长链接 = `https://help.daedalus-crm.example.com/docs/desktop/import/troubleshooting/${"very-long-segment-".repeat(8)}?ref=feedback&utm_source=app&session=${"a1b2c3d4".repeat(5)}`;
const 无空格 = `PO-2026-UK-${"LUXEREHOME".repeat(12)}-INV-00012345678901234567890`;

const 一串反馈 = [
  {
    id: "fb_long",
    at: 时(12),
    body: "导入 Excel 的时候卡在 87%，等了十分钟也没动。表里有 3200 行客户，有几列是英文公司名，特别长的那种 SCANDINAVIAN HOME FURNISHING DISTRIBUTION LIMITED。",
    消息: [
      {
        id: "m1",
        at: 时(13),
        谁: "团队",
        body: `你好，谢谢你这么详细地描述！\n\n我们查了一下，是表里有一列合并单元格，导入时会一直重试那一行。下一版（0.46.23）会直接跳过并告诉你是第几行。\n\n现在可以先这样绕过去：\n1. 在 Excel 里选中整张表 → 取消合并单元格\n2. 另存为 .xlsx 再导入\n\n详细步骤和截图在这里：${长链接}\n\n如果还是不行，把那一行发我们看看。`,
      },
      { id: "m2", at: 时(14), 谁: "我", body: `试了，还是卡。出问题的那一行订单号是 ${无空格}，会不会和这个有关？` },
      { id: "m3", at: 时(15), 谁: "团队", body: `对，就是它：订单号超过了 120 个字符。已经修好，下一版放宽到 500。\n\n${无空格}` },
    ],
  },
  {
    id: "fb_ar",
    at: 时(16),
    body: "مرحبا، أريد أن أعرف كيف أصدّر قائمة العملاء إلى ملف CSV باللغة العربية دون أن تتلف الحروف.",
    消息: [{ id: "m4", at: 时(17), 谁: "团队", body: "شكراً لك! التصدير بترميز UTF-8 مع BOM سيكون متاحاً في الإصدار القادم. 🙏\n导出时会自动带上 BOM，Excel 打开不会乱码。" }],
  },
  {
    id: "fb_emoji",
    at: 时(18),
    body: "🎉🎉🎉 新版本的看板太好用了！！👍🏽👍🏽 就是暗色模式下拖动卡片时阴影有点看不清 👨‍👩‍👧‍👦",
    消息: [{ id: "m5", at: 时(18, 15), 谁: "团队", body: "哈哈谢谢 🥳🥳！阴影的事记下了，下一版调深一点 🌙✨👨‍👩‍👧‍👦🏳️‍🌈" }],
  },
  { id: "fb_wait", at: 时(19, 7), body: "能不能加一个按国家筛选客户的功能？", 消息: [] },
];

async function 放数据(数据: unknown) {
  const r = await fetch(`${CLOUD_URL}/__stub/feedback`, { method: 数据 ? "POST" : "DELETE", body: 数据 ? JSON.stringify(数据) : undefined });
  expect(r.ok).toBe(true);
}

async function 摆好(page: Page, 宽: number, 摆: string) {
  await page.setViewportSize({ width: 宽, height: 680 });
  await 进门(page);
  await page.evaluate((m) => {
    try {
      localStorage.setItem("rail-w", m === "左栏最宽" ? "360" : "220");
      localStorage.setItem("dock-w", "380");
    } catch { /* 存不下就是默认 */ }
  }, 摆);
}

/**
 * 左下角的提示一次打开应用只出一次（记在 sessionStorage，FeedbackReplyToast）。进门落地的那一页上它可能已经出过了——
 * 云端回得快（CI 的生产构建）就出在那一页，回得慢就出在下一页，看谁先到（10-19 CI 红过一次就是这个）。
 * 所以在「第一次打开 址」这一页的脚本跑之前把记号清掉一次，等于「刚打开应用」，不靠赛跑；
 * 只清一次：同一次打开里再刷新，提示不该再出（下面钉着）。进门之前调
 */
async function 当作刚打开应用(page: Page, 址: string) {
  await page.addInitScript((路) => {
    try {
      if (location.pathname === 路 && !sessionStorage.getItem("e2e-toast-reset")) {
        sessionStorage.removeItem("feedback-toast-shown");
        sessionStorage.setItem("e2e-toast-reset", "1");
      }
    } catch { /* 没有就是没有 */ }
  }, 址);
}

async function 去(page: Page, 址: string, 摆: string) {
  await page.goto(址);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  const 弹窗 = page.getByRole("dialog", { name: /已更新到/ });
  if (await 弹窗.isVisible().catch(() => false)) await 弹窗.getByRole("button", { name: /知\s*道\s*了/ }).click();
  if (摆 === "AI栏常驻") {
    const 栏 = page.getByRole("complementary", { name: "AI 面板" });
    if (!(await 栏.isVisible().catch(() => false))) await page.keyboard.press("Control+j");
    await expect(栏).toBeVisible();
  }
  await page.waitForTimeout(400);
}

async function 量(page: Page, 名: string, 问题们: string[]) {
  for (const [比例, 段] of [[0, "顶"], [1, "底"]] as const) {
    await page.evaluate((f) => {
      for (const e of document.querySelectorAll<HTMLElement>(".mfb-list, .mfb-msgs")) e.scrollTop = (e.scrollHeight - e.clientHeight) * f;
      window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * f);
    }, 比例);
    await page.waitForTimeout(150);
    const 问题 = await 查排版(page, { 忽略 });
    if (问题.length) 问题们.push(`「${名}-${段}」\n${说问题(问题)}`);
    if (出处) {
      mkdirSync(出处, { recursive: true });
      await page.screenshot({ path: path.join(出处, `${名}-${段}.png`) });
    }
  }
}

test.beforeAll(async ({ browser }) => {
  // 每轮从「一条都没看过」开始：红点、提示都该出
  rmSync(path.join(DATA_DIR, "feedback-seen.json"), { force: true });
  await 放数据(一串反馈);
  // 单跑这一份时库是新的、进门会落到「你主要做哪一类生意？」：先选掉（整轮跑时前面的用例已经选过）
  const page = await browser.newPage();
  try {
    await 进门(page);
    const 选类型 = page.getByRole("heading", { name: "你主要做哪一类生意？" });
    if (await 选类型.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false)) {
      await page.getByRole("button", { name: /用通用销售开始/ }).click();
      await expect(page).not.toHaveURL(/\/start/);
    }
  } finally {
    await page.close();
  }
});

test.afterAll(async ({ request }) => {
  await 放数据(null);
  // 本地服务那一分钟的缓存也清掉：同一台服务后面跑的闸门不该冒红点和提示
  await request.get("/api/feedback/mine?fresh=1").catch(() => {});
  rmSync(path.join(DATA_DIR, "feedback-seen.json"), { force: true });
});

for (const 宽 of [1024, 1280, 1366]) {
  for (const 摆 of ["默认", "AI栏常驻", "左栏最宽"]) {
    test(`${宽} 宽 · ${摆}：我的反馈不撑破、不被切、不被盖住`, async ({ page }) => {
      test.setTimeout(3 * 60_000);
      rmSync(path.join(DATA_DIR, "feedback-seen.json"), { force: true });
      await 当作刚打开应用(page, "/customers");
      await 摆好(page, 宽, 摆);
      // 等落地那一页取到回复（红点出来 = 提示也在那一页出过了）：每次都走 CI 上那种「提示先出在别处」的最坏情况
      await expect(page.getByTestId("feedback-dot")).toBeVisible();
      const 问题们: string[] = [];

      // 左下角的提示 + 左栏红点：在客户列表上量（最常停的一页）
      await 去(page, "/customers", 摆);
      await expect(page.getByTestId("feedback-dot")).toBeVisible();
      await expect(page.getByTestId("feedback-toast")).toBeVisible();
      await 量(page, `${宽}-${摆}-提示`, 问题们);
      // 同一次打开里再刷新：红点还在，提示不再出
      await 去(page, "/customers", 摆);
      await expect(page.getByTestId("feedback-dot")).toBeVisible();
      await expect(page.getByTestId("feedback-toast")).toHaveCount(0);

      // 列表（宽的时候右边自动打开最新那一串）
      await 去(page, "/feedback", 摆);
      await expect(page.getByTestId("my-feedback")).toBeVisible();
      await expect(page.getByTestId("feedback-toast")).toHaveCount(0);
      await 量(page, `${宽}-${摆}-列表`, 问题们);

      // 每一串都打开量一次：长回复 + 长链接 + 无空格、阿拉伯文、emoji、还没回复的
      for (const f of 一串反馈) {
        await 去(page, `/feedback?id=${f.id}`, 摆);
        await expect(page.getByRole("region", { name: "对话" })).toBeVisible();
        if (!f.消息.length) await expect(page.getByText("我们看到了，回复会出现在这里")).toBeVisible();
        else await expect(page.getByText("Daedalus 团队").first()).toBeVisible();
        await 量(page, `${宽}-${摆}-${f.id}`, 问题们);
      }

      expect(问题们, `${宽} 宽 · ${摆}：\n${问题们.join("\n\n")}`).toEqual([]);
    });
  }
}

test("窄（1024 + AI 栏）：先列表，点进去是对话，‹ 回到列表", async ({ page }) => {
  await 摆好(page, 1024, "AI栏常驻");
  await 去(page, "/feedback", "AI栏常驻");
  const 盒 = page.getByTestId("my-feedback");
  await expect(盒).toHaveClass(/is-narrow/);
  await expect(page.getByRole("region", { name: "对话" })).toBeHidden();
  await page.getByRole("list", { name: "我发过的反馈" }).getByRole("button").first().click();
  await expect(page.getByRole("region", { name: "对话" })).toBeVisible();
  await expect(page.getByRole("list", { name: "我发过的反馈" })).toBeHidden();
  await page.getByRole("button", { name: /全部反馈/ }).click();
  await expect(page.getByRole("list", { name: "我发过的反馈" })).toBeVisible();
});

/*
  外观：深色（科技主题的原底）、白底、Mac 毛玻璃、Windows（让出标题栏那条、压深字色）。
  壳挂的那几个 class 在浏览器里由 addInitScript 代挂：毛玻璃在浏览器里背后没有桌面，只量排版、截图看配色
*/
const 外观们: { 名: string; 外观: { paper: string; skin: string }; class?: string; 宽: number }[] = [
  { 名: "深色", 外观: { paper: "tone", skin: "tech" }, 宽: 1280 },
  { 名: "深色-窄", 外观: { paper: "tone", skin: "tech" }, 宽: 1024 },
  { 名: "白底", 外观: { paper: "white", skin: "now" }, 宽: 1280 },
  { 名: "毛玻璃", 外观: { paper: "tone", skin: "now" }, class: "glass", 宽: 1280 },
  { 名: "Windows", 外观: { paper: "tone", skin: "now" }, class: "os-win", 宽: 1024 },
];
for (const w of 外观们) {
  test(`外观 · ${w.名}：我的反馈和提示不撑破、不被切`, async ({ page }) => {
    rmSync(path.join(DATA_DIR, "feedback-seen.json"), { force: true });
    await page.addInitScript(({ 外观, cls }) => {
      try {
        localStorage.setItem("daedalus.appearance", JSON.stringify(外观));
      } catch { /* 存不下就是默认 */ }
      if (cls) document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add(cls));
    }, { 外观: w.外观, cls: w.class ?? "" });
    await 当作刚打开应用(page, "/customers");
    await 摆好(page, w.宽, w.宽 === 1024 ? "AI栏常驻" : "默认");
    const 问题们: string[] = [];
    await 去(page, "/customers", "默认");
    await expect(page.getByTestId("feedback-toast")).toBeVisible();
    await 量(page, `外观-${w.名}-提示`, 问题们);
    await 去(page, "/feedback?id=fb_long", w.宽 === 1024 ? "AI栏常驻" : "默认");
    await expect(page.getByRole("region", { name: "对话" })).toBeVisible();
    await 量(page, `外观-${w.名}-对话`, 问题们);
    expect(问题们, `外观 · ${w.名}：\n${问题们.join("\n\n")}`).toEqual([]);
  });
}
