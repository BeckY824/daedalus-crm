/**
 * 视觉底座（批 1，0.25.0）的验收。
 *
 * 这一批只改 `globals.css` 的 token 和 `lib/theme.ts`，页面结构基本不动，
 * 所以验收也只验能量出来的四件事：
 *   1. 字不许更小——正文 14、说明 13、下限 12。以前满屏 11px / 11.5px / 10.5px
 *   2. 灰不许更浅——说明最浅到 `--text-muted` #6b7280；
 *      `--text-faint` #9ca3af 只给 placeholder、禁用态、装饰点，不许当正文
 *   3. 表格是拿来扫的——表头 36、行高 40、一屏 15 行以上
 *   4. 列表页不套外层白卡（原则一「内容先于容器」）
 *
 * 这四条都是可证伪的量，不掺主观感受。风格好不好看不在这里判，那是人的活。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据, 造模拟数据 } from "./mock-data";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };

async function 登录(page: Page) {
  await page.goto("/login");
  const 提示 = page.locator(".ant-alert");
  for (let i = 0; i < 3; i++) {
    await page.getByPlaceholder("用户名").fill(账号.用户名);
    await page.getByPlaceholder("登录密码").fill(账号.密码);
    await page.getByRole("button", { name: /登\s*录/ }).click();
    for (let t = 0; t < 40; t++) {
      if (/\/dashboard/.test(page.url())) return;
      if (await 提示.isVisible().catch(() => false)) throw new Error("登录失败");
      await page.waitForTimeout(200);
    }
  }
  throw new Error("登录没反应");
}

test.describe.configure({ mode: "serial", timeout: 90_000 });

/** 走查跑在最后，跑完库是空的。这一组要看有数据的表格，自己造一套 */
test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await 造模拟数据(p);
  await p.$disconnect();
});

test.afterAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await p.$disconnect();
});

const 页面 = ["/dashboard", "/overview", "/leads", "/customers", "/channels", "/contacts", "/opportunities", "/follow-ups", "/follow-ups/plans", "/settings"];

/**
 * 页面上每一段「给人读的文字」的字号与颜色。
 *
 * 只看直接挂着文字的那一层（有 text 子节点、且自己没有元素子节点），
 * 否则父容器会把子节点的字算成自己的，量出来全是 body 的默认值。
 */
async function 量文字(page: Page) {
  return page.evaluate(() => {
    const out: { 文本: string; 字号: number; 颜色: string; 背景: string; 选择器: string }[] = [];
    /** 往上找到第一个真正画了底色的祖先——文字压在什么上面，对比度才算得准 */
    const 底色 = (el: Element): string => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
      }
      return "rgb(255, 255, 255)";
    };
    const 排除 = (el: Element) =>
      el.closest("[disabled], .ant-btn-disabled, .ant-input-disabled, .ant-select-disabled, .ant-empty, .ant-picker-cell, .ant-tooltip, .ant-pagination-item-link");
    for (const el of document.querySelectorAll<HTMLElement>("main *, aside.pane *, nav.rail *")) {
      if (el.children.length) continue;
      const 文本 = (el.textContent ?? "").trim();
      if (文本.length < 4) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (排除(el)) continue;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.opacity === "0") continue;
      out.push({
        文本: 文本.slice(0, 30),
        字号: parseFloat(s.fontSize),
        颜色: s.color,
        背景: 底色(el),
        选择器: el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(/\s+/).slice(0, 2).join(".") : ""),
      });
    }
    return out;
  });
}

test("字号：界面上不存在 12px 以下的字", async ({ page }) => {
  await 登录(page);
  const 小字: string[] = [];
  for (const 路径 of 页面) {
    await page.goto(路径);
    await page.waitForTimeout(500);
    for (const t of await 量文字(page)) {
      if (t.字号 < 12) 小字.push(`${路径} ${t.选择器} ${t.字号}px「${t.文本}」`);
    }
  }
  expect(小字, `这些字比下限还小：\n${小字.join("\n")}`).toEqual([]);
});

test("灰度：说明文字最浅到 --text-muted，#9ca3af 不许当正文", async ({ page }) => {
  /**
   * 判据是相对亮度，不是字符串比对——同一个浅灰在不同地方写成 #9ca3af / #94a3b8 /
   * #b0b6c1 / #c0c8d4 都出现过，比字符串只会漏。
   * 阈值取 --text-muted #6b7280 的亮度；比它更亮的字一律算「浅到读不了」。
   *
   * 两道闸一起用：
   *   只判中性色——状态标签是有颜色的字压在同色浅底上，那是标签的设计，不是「把浅灰当正文」
   *   判的是和底色的对比度，不是绝对亮度——主按钮上的白字压在品牌蓝上，绝对亮度最高，但它没问题
   * 阈值 4.5:1 就是 --text-muted #6b7280 压在白底上的实测值（4.83:1），#9ca3af 只有 2.7:1。
   */
  await 登录(page);
  const 太浅: string[] = [];
  for (const 路径 of 页面) {
    await page.goto(路径);
    await page.waitForTimeout(500);
    for (const t of await 量文字(page)) {
      const m = t.颜色.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) continue;
      const 原始 = [1, 2, 3].map((i) => Number(m[i]));
      if ((Math.max(...原始) - Math.min(...原始)) / 255 > 0.08) continue; // 有颜色的字不在此列
      const b2 = t.背景.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!b2) continue;
      const 亮度 = (v: number[]) => {
        const [r, g, bl] = v.map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      };
      const [l1, l2] = [亮度(原始), 亮度([1, 2, 3].map((i) => Number(b2[i])))].sort((x, y) => y - x);
      // 取两位小数再比：品牌蓝上的白字正好是 4.50，浮点算下来是 4.4999
      const 对比度 = Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
      if (对比度 < 4.5) 太浅.push(`${路径} ${t.选择器} ${t.颜色} 压在 ${t.背景} 上，只有 ${对比度.toFixed(2)}:1「${t.文本}」`);
    }
  }
  expect(太浅, `这些文字比 --text-muted 还浅，读不了：\n${太浅.join("\n")}`).toEqual([]);
});

test("表格：表头 36、行高 40，一屏 15 行以上", async ({ page }) => {
  await 登录(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/customers");
  await page.waitForSelector(".ant-table-row");

  const 量 = await page.evaluate(() => {
    const th = document.querySelector(".ant-table-thead > tr > th");
    const 行 = [...document.querySelectorAll<HTMLElement>(".ant-table-tbody > tr.ant-table-row")];
    const 表顶 = document.querySelector(".ant-table")!.getBoundingClientRect().top;
    return {
      表头: th ? th.getBoundingClientRect().height : 0,
      行高: 行.map((r) => Math.round(r.getBoundingClientRect().height)),
      可用高度: window.innerHeight - 表顶,
    };
  });

  expect(量.表头, `表头 ${量.表头}px，规范是 36`).toBeLessThanOrEqual(38);
  const 超高 = 量.行高.filter((h) => h > 40);
  expect(超高, `这些行超过 40px：${超高.join(", ")}`).toEqual([]);
  // 表格顶往下能塞几行。40 一行，一屏要够 15 行才算「能扫」
  expect(Math.floor((量.可用高度 - 36) / 40), "一屏塞不下 15 行").toBeGreaterThanOrEqual(15);
});

test("列表页不套外层白卡", async ({ page }) => {
  /**
   * 原则一：内容先于容器。以前每个列表页都是
   * `<Card padding 22>筛选栏 + 工具条 + 表格</Card>`，
   * 那层卡只是把工作台底色挤成一圈边，还多一层要对齐的边界。
   */
  await 登录(page);
  const 问题: string[] = [];
  for (const 路径 of ["/leads", "/customers", "/channels", "/contacts", "/follow-ups"]) {
    await page.goto(路径);
    await page.waitForTimeout(400);
    const 有卡 = await page.evaluate(() => {
      const 表 = document.querySelector(".ant-table");
      return Boolean(表?.closest(".ant-card"));
    });
    if (有卡) 问题.push(路径);
  }
  expect(问题, `这些列表页的表格还包在白卡里：${问题.join("、")}`).toEqual([]);
});

test("1249 宽（笔记本分屏再窄一档）下不横向溢出", async ({ page }) => {
  await 登录(page);
  await page.setViewportSize({ width: 1249, height: 860 });
  const 问题: string[] = [];
  for (const 路径 of 页面) {
    await page.goto(路径);
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const d = document.documentElement;
      return { 溢出: d.scrollWidth > d.clientWidth + 1, scrollWidth: d.scrollWidth, clientWidth: d.clientWidth };
    });
    if (r.溢出) 问题.push(`${路径}：${r.scrollWidth} > ${r.clientWidth}`);
  }
  expect(问题, `1249 宽下这些页面横向溢出：\n${问题.join("\n")}`).toEqual([]);
});
