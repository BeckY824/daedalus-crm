/**
 * 运营台排版压测（2026-10-19 团队版主动排查）。数据见 e2e/team-qa-ops-setup.ts（长邮箱、长名字、多语种、8 人团队……）。
 *
 * 每个宽度把运营台每一页走一遍：从上往下一屏一屏滚，每屏调一次 查排版（它只看视口里的），合并去重；
 * 外加几个要点开才看得到的状态（团队开通记录展开、开通 / 续费弹框、加次数弹框、反馈回复框）。
 * 顺带收控制台报错、页面异常和页面上露出来的 NaN / undefined / Invalid Date。
 *
 *   E2E_SHOT_DIR  截图和 运营台排版问题.json 放哪（不给就放 test-results/team-qa-ops）
 *   TEAM_QA_REPORT=1  只记录不判失败
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { 查排版, 说问题, type 排版问题 } from "./layout-audit";
import { SEED_JSON } from "./team-qa-ops-setup";

/** TEAM_QA_OPS_WIDTHS=1024,1280,1366 只跑这几个宽度 */
const 宽们 = (process.env.TEAM_QA_OPS_WIDTHS || "1024,1093,1280,1366,1536,1920").split(",").map(Number).filter(Boolean);
const 高 = 900;
const 只记录 = process.env.TEAM_QA_REPORT === "1";
const 图目录 = process.env.E2E_SHOT_DIR || path.resolve(__dirname, "../test-results/team-qa-ops");
const T = "token=e2e-admin-token";

/** 开发模式下 Next 左下角那颗「N issues」小圆钮会压在侧栏「刷新」上：它不是产品的一部分，查之前藏掉 */
const 藏开发浮层 = "nextjs-portal{display:none!important}";

type 记录 = { 宽: number; 页: string; 网址: string; 问题: 排版问题[]; 报错: string[]; 怪字: string[]; 截图?: string };
const 全部: 记录[] = [];

type 一页 = {
  名: string;
  址: (s: Seed) => string;
  /** 打开之后再做点什么（展开、点开弹框）；返回 查排版 的 范围 */
  做?: (page: Page) => Promise<string | void>;
  忽略?: string[];
};
type Seed = { 长用户: string; 测试用户: string; 无空格用户: string; 阿拉伯用户: string; 用超了: string; 长团队: string; 俄文团队: string };

const 页们: 一页[] = [
  { 名: "总览", 址: () => `/admin?${T}` },
  { 名: "用户列表", 址: () => `/admin/users?${T}` },
  { 名: "用户详情-长名字", 址: (s) => `/admin/users/${s.长用户}?${T}` },
  { 名: "用户详情-无空格", 址: (s) => `/admin/users/${s.无空格用户}?${T}` },
  { 名: "用户详情-测试号", 址: (s) => `/admin/users/${s.测试用户}?${T}` },
  { 名: "用户详情-用超了", 址: (s) => `/admin/users/${s.用超了}?${T}` },
  { 名: "团队同步", 址: () => `/admin/sync?${T}` },
  {
    名: "团队同步-展开记录",
    址: () => `/admin/sync?${T}`,
    做: async (page) => {
      // 没有记录的行那颗是占位的（-spaced，看不见），点它会一直等
      await page.locator(".ant-table-row-expand-icon:not(.ant-table-row-expand-icon-spaced)").first().click();
      await page.locator(".opx-plan-log").first().waitFor();
    },
  },
  {
    名: "团队同步-开通弹框",
    址: () => `/admin/sync?${T}`,
    做: async (page) => {
      await page.getByRole("button", { name: "开通 / 续费" }).first().click();
      await page.locator(".ant-modal").waitFor();
      await page.waitForTimeout(400);
      return ".ant-modal";
    },
  },
  { 名: "团队详情", 址: (s) => `/admin/sync/${s.长团队}?${T}` },
  {
    名: "团队详情-加次数弹框",
    址: (s) => `/admin/sync/${s.长团队}?${T}`,
    做: async (page) => {
      await page.getByRole("button", { name: /加AI次数/ }).first().click();
      await page.locator(".ant-modal").waitFor();
      await page.waitForTimeout(400);
      return ".ant-modal";
    },
  },
  { 名: "俄文团队", 址: (s) => `/admin/sync/${s.俄文团队}?${T}` },
  { 名: "次数", 址: () => `/admin/credits?${T}` },
  { 名: "次数-搜索", 址: () => `/admin/credits?${T}&q=${encodeURIComponent("example")}` },
  { 名: "模型用量", 址: () => `/admin/usage?${T}` },
  { 名: "反馈", 址: () => `/admin/feedback?${T}` },
  {
    名: "反馈-回复框",
    址: () => `/admin/feedback?${T}`,
    做: async (page) => {
      await page.getByRole("button", { name: /^回\s?复$/ }).first().click();
      await page.locator(".opx-fb-compose").first().waitFor();
    },
  },
  { 名: "工作区", 址: () => `/admin/workspaces?${T}` },
];

async function 一屏屏查(page: Page, 范围: string | undefined, 忽略: string[] | undefined): Promise<排版问题[]> {
  const 见过 = new Map<string, 排版问题>();
  const 全高 = 范围 ? 高 : await page.evaluate(() => document.scrollingElement!.scrollHeight);
  for (let y = 0; y < 全高; y += Math.round(高 * 0.8)) {
    if (!范围) {
      await page.evaluate((y) => window.scrollTo(0, y), y);
      await page.waitForTimeout(150);
    }
    for (const x of await 查排版(page, { 范围, 忽略 })) {
      const k = `${x.类}|${x.在哪}|${x.字}`;
      if (!见过.has(k)) 见过.set(k, x);
    }
    if (范围) break;
  }
  if (!范围) await page.evaluate(() => window.scrollTo(0, 0));
  return [...见过.values()];
}

for (const 宽 of 宽们) {
  test(`运营台排版 · ${宽}px`, async ({ page }) => {
    const s = JSON.parse(fs.readFileSync(SEED_JSON, "utf8")) as Seed;
    await page.setViewportSize({ width: 宽, height: 高 });
    let 报错: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") 报错.push(`[console.${m.type()}] ${m.text().slice(0, 400)}`);
    });
    page.on("pageerror", (e) => 报错.push(`[pageerror] ${e.message.slice(0, 400)}`));
    page.on("response", (r) => {
      if (r.status() >= 500 && r.url().includes("/admin")) 报错.push(`[http ${r.status()}] ${r.url()}`);
    });

    for (const p of 页们) {
      报错 = [];
      const 网址 = p.址(s);
      const res = await page.goto(网址, { waitUntil: "networkidle", timeout: 180_000 });
      if (!res || res.status() >= 400) 报错.push(`[http ${res?.status()}] ${网址}`);
      await page.addStyleTag({ content: 藏开发浮层 });
      await page.locator(".opx-main").waitFor({ timeout: 60_000 });
      // echarts 和 antd 表格在水合后才排好
      await page.waitForTimeout(700);
      let 范围: string | undefined;
      try {
        范围 = p.做 ? (await p.做(page)) || undefined : undefined;
      } catch (e) {
        报错.push(`[交互没做成] ${(e as Error).message.split("\n")[0]}`);
      }
      // 开发模式第一次编译某页时偶尔整页重载一次（执行上下文没了）：等它载完再查一遍
      const 问题 = await 一屏屏查(page, 范围, p.忽略).catch(async (e) => {
        if (!/context was destroyed|navigation/i.test(String(e))) throw e;
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(700);
        return 一屏屏查(page, 范围, p.忽略);
      });
      const 怪字 = await page.evaluate(() => {
        const t = document.querySelector(".opx")?.textContent ?? document.body.textContent ?? "";
        return [...new Set((t.match(/.{0,20}(NaN|undefined|Invalid Date|\[object Object\]|null 次|Infinity).{0,20}/g) ?? []).map((x) => x.trim()))];
      });
      const 记: 记录 = { 宽, 页: p.名, 网址, 问题, 报错: [...new Set(报错)], 怪字 };
      fs.mkdirSync(path.join(图目录, "全部"), { recursive: true });
      const 名 = `运营台-${宽}-${p.名}.png`;
      if (问题.length || 记.报错.length || 怪字.length) {
        await page.screenshot({ path: path.join(图目录, 名), fullPage: !范围 });
        记.截图 = path.join(图目录, 名);
      }
      // 没报问题的也留一张，人眼过一遍（检查器看不出「挤成一团但没溢出」这种）
      await page.screenshot({ path: path.join(图目录, "全部", 名), fullPage: !范围 });
      全部.push(记);
      // 弹框开着就关掉，免得带到下一页
      await page.keyboard.press("Escape").catch(() => {});
    }

    const 这宽的 = 全部.filter((x) => x.宽 === 宽);
    fs.writeFileSync(path.join(图目录, `运营台排版问题-${宽}.json`), JSON.stringify(这宽的, null, 2));
    if (!只记录) {
      const 有问题 = 这宽的.filter((x) => x.问题.length || x.报错.length || x.怪字.length);
      expect(有问题.map((x) => `${x.页}：\n${说问题(x.问题)}\n${x.报错.join("\n")}\n${x.怪字.join("\n")}`).join("\n\n")).toBe("");
    }
  });
}

test.afterAll(() => {
  fs.mkdirSync(图目录, { recursive: true });
  fs.writeFileSync(path.join(图目录, "运营台排版问题.json"), JSON.stringify(全部.filter((x) => x.问题.length || x.报错.length || x.怪字.length), null, 2));
});
