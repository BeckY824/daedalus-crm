/**
 * 设置 → 团队的排版（2026-10-19 团队版主动排查）：Windows 常见宽度和缩放下，长团队名、长成员名 / 邮箱、价格表、
 * 到期提示、我的设备满 3 台、待授权的手机这些都摆出来，用 e2e/layout-audit.ts 量一遍：撑破、被切、被盖住、短字被挤成竖排。
 *
 * 宽度是 CSS 像素：1366@125% ≈ 1093，1920@125% = 1536，1920@150% = 1280，1280@125% = 1024。毛玻璃（html.glass）开 / 关各量一次。
 *
 *   E2E_PORT=3520 npx playwright test -c playwright.layout.config.ts e2e-layout/团队页.spec.ts
 *   TEAM_QA_REPORT=1 E2E_SHOT_DIR=… 同上   # 只记下来（JSON + 有问题那屏的截图），不判失败
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLOUD_URL, DATA_DIR, 云端账号 } from "../e2e-desktop/env";
import { 设云端团队, 连库, 进门 } from "../e2e-desktop/helpers";
import { 查排版, 说问题, type 排版问题 } from "../e2e/layout-audit";

test.describe.configure({ mode: "serial" });

const 宽们 = [1024, 1093, 1280, 1366, 1536, 1920];
const 只记 = process.env.TEAM_QA_REPORT === "1";
const 出处 = process.env.E2E_SHOT_DIR ? path.join(process.env.E2E_SHOT_DIR, "桌面") : null;
const 记录: { 宽: number; 屏: string; 问题: 排版问题[] }[] = [];

const 长团队名 = "深圳市某某照明电器科技股份有限公司外贸二部（中东 / 东欧 / 拉美大区）销售团队";
const 成员们 = [
  { accountId: 云端账号.id, name: 云端账号.name, contact: 云端账号.contact, role: "owner" },
  { accountId: "acc_wang", name: "王磊", contact: "wang@e2e.local", role: "member" },
  { accountId: "acc_long", name: "Mohammed bin Abdullah Al-Rashid Al-Qahtani", contact: "procurement.department.lighting.projects@al-rashid-trading-and-contracting.example.com", role: "member" },
  { accountId: "acc_ru", name: "Александра Константиновна Белозерская", contact: "a.belozerskaya@svetotekhnika-severo-zapad.example.ru", role: "member" },
  { accountId: "acc_emoji", name: "🌟小美😀👍🏽", contact: "+86 138 0013 8000", role: "member" },
  { accountId: "acc_cn", name: "欧阳娜娜娜娜娜娜娜娜娜", contact: "ouyang@e2e.local", role: "member" },
];
const 团队 = (改: Record<string, unknown> = {}) => ({
  id: "t_e2e_layout", name: 长团队名, active: true, 我是建的人: true, paidUntil: "2026-10-22", 剩几天: 3, seats: 6, expired: false, 成员: 成员们, ...改,
});
const 额外 = {
  pricing: {
    trialDays: 7,
    prices: [
      { months: 1, label: "1 个月", perSeat: 99, perMonth: 99 },
      { months: 3, label: "3 个月", perSeat: 269, perMonth: 89.67 },
      { months: 6, label: "半年", perSeat: 499, perMonth: 83.17 },
      { months: 12, label: "1 年", perSeat: 899, perMonth: 74.92 },
    ],
  },
  devices: [
    { device: "dev_e2e_layout", 种类: "电脑", label: "LAPTOP-8F3K2QW（Windows 11 家庭中文版）", 连上: "2026-10-01T02:00:00Z", 最近同步: "2026-10-19T01:00:00Z", 这台: true },
    { device: "d0123456789ab", 种类: "电脑", label: "MacBook Pro（14 英寸，2023 年）Mohammed 的办公室那台", 连上: "2026-10-05T02:00:00Z", 最近同步: null, 这台: false },
    { device: "m_e2e_phone", 种类: "手机", label: "iPhone 15 Pro Max · Safari（主屏幕）", 连上: "2026-10-10T02:00:00Z", 最近同步: "2026-10-18T12:00:00Z", 这台: false },
  ],
  links: [{ id: "lk_e2e", label: "HUAWEI Mate 60 Pro · 华为浏览器 · 深圳市南山区", device: "m_e2e_new", pubKey: "A".repeat(43), createdAt: "2026-10-19T08:00:00Z" }],
};

async function 设额外(page: Page, x: unknown) {
  expect((await page.request.post(`${CLOUD_URL}/__stub/extra`, { data: x })).ok()).toBe(true);
}

/** 这台进了团队：.team.json（和 11 那组同形） */
function 进了团队(在: boolean) {
  const f = path.join(DATA_DIR, ".team.json");
  if (!在) return rmSync(f, { force: true });
  writeFileSync(f, JSON.stringify({ teamId: "t_e2e_layout", teamName: 长团队名, joinSecret: "e2e", key: "A".repeat(43), device: "dev_e2e_layout", pulled: 0, ownerAccountId: 云端账号.id }), { mode: 0o600 });
}

async function 进设置团队(page: Page) {
  await 进门(page, "/settings?tab=team");
  if (await page.getByRole("heading", { name: "你主要做哪一类生意？" }).isVisible()) {
    await page.getByRole("button", { name: /用通用销售开始/ }).click();
    await expect(page).not.toHaveURL(/\/start/);
    await 进门(page, "/settings?tab=team");
  }
  // 新库第一次进主界面会在页面出来之后自己弹「已更新到 …」：等一下，弹了就关
  const 更新了 = page.getByRole("dialog", { name: /已更新到/ });
  if (await 更新了.waitFor({ state: "visible", timeout: 4_000 }).then(() => true, () => false)) {
    // 有手机等着允许时批准框会叠在它上面、挡住「知道了」：先关批准框（× 只记在这次打开里），关完更新记录再进一次，批准框会重新弹
    const 批准框开着 = await page.getByRole("dialog", { name: /允许「/ }).isVisible().catch(() => false);
    if (批准框开着) await 关批准框(page);
    await 更新了.getByRole("button", { name: /知\s*道\s*了/ }).click();
    await expect(更新了).toBeHidden();
    if (批准框开着) await 进门(page, "/settings?tab=team");
  }
  await expect(page.getByRole("tabpanel", { name: /^团队/ })).toBeVisible();
  await page.waitForLoadState("networkidle").catch(() => {});
}

/** 有手机等着允许时，老板那台一进来就弹「允许 … 查看和记录你的客户？」：量这个框本身，再点右上 × （= 稍后，这次打开不再弹） */
async function 量批准框(page: Page, 宽: number) {
  const 框 = page.getByRole("dialog", { name: /允许「/ });
  if (!(await 框.waitFor({ state: "visible", timeout: 4_000 }).then(() => true, () => false))) return;
  await page.waitForTimeout(300);
  const 问题 = await 查排版(page, { 范围: "[role=dialog]:has(.anticon-mobile)", 忽略: [".ant-message", ".ant-notification"] });
  if (问题.length) {
    记录.push({ 宽, 屏: "手机批准框", 问题 });
    if (出处) { mkdirSync(出处, { recursive: true }); await page.screenshot({ path: path.join(出处, `桌面-${宽}-手机批准框.png`) }); }
  }
  if (!只记) expect(问题, `${宽} 宽「手机批准框」：\n${说问题(问题)}`).toEqual([]);
  await 框.getByRole("button", { name: "关闭" }).click();
  await expect(框).toBeHidden();
}

async function 关批准框(page: Page) {
  const 框 = page.getByRole("dialog", { name: /允许「/ });
  if (await 框.waitFor({ state: "visible", timeout: 2_000 }).then(() => true, () => false)) {
    await 框.getByRole("button", { name: "关闭" }).click();
    await expect(框).toBeHidden();
  }
}

/** 页面上所有能竖着滚的盒子都滚到同一个比例（0 顶、1 底），量完一屏再滚下一段 */
async function 滚到(page: Page, 比例: number) {
  await page.evaluate((f) => {
    for (const e of document.querySelectorAll<HTMLElement>("*")) {
      const oy = getComputedStyle(e).overflowY;
      if ((oy === "auto" || oy === "scroll") && e.scrollHeight > e.clientHeight + 1) e.scrollTop = (e.scrollHeight - e.clientHeight) * f;
    }
    window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * f);
  }, 比例);
  await page.waitForTimeout(150);
}

async function 量(page: Page, 宽: number, 屏: string) {
  await page.waitForTimeout(300);
  const 问题 = await 查排版(page, { 忽略: [".ant-message", ".ant-notification"] });
  if (问题.length) {
    记录.push({ 宽, 屏, 问题 });
    if (出处) { mkdirSync(出处, { recursive: true }); await page.screenshot({ path: path.join(出处, `桌面-${宽}-${屏}.png`) }); }
  }
  if (!只记) expect(问题, `${宽} 宽「${屏}」：\n${说问题(问题)}`).toEqual([]);
}

/** 顶、中、底各量一次；毛玻璃开着再量一遍 */
async function 量整页(page: Page, 宽: number, 屏: string) {
  for (const 玻璃 of [false, true]) {
    await page.evaluate((g) => {
      document.documentElement.classList.toggle("glass", g);
      // 透明窗口后面垫一张花的「壁纸」，玻璃上的字看不看得清一眼就知道
      document.documentElement.style.background = g ? "linear-gradient(135deg, #f6a5c0, #8fd3f4 50%, #fbc779)" : "";
    }, 玻璃);
    for (const [比例, 段] of [[0, "顶"], [0.5, "中"], [1, "底"]] as const) {
      await 滚到(page, 比例);
      await 量(page, 宽, `${屏}-${玻璃 ? "玻璃" : "实底"}-${段}`);
    }
  }
}

test.beforeAll(async () => {
  const p = 连库();
  try {
    for (const m of 成员们) {
      const id = `acct_${m.accountId}`;
      await p.user.upsert({ where: { id }, create: { id, email: `${m.accountId}@e2e.local`, name: m.name, password: "x", role: m.role === "owner" ? "ADMIN" : "SALES", title: "" }, update: { active: true, name: m.name } });
    }
  } finally {
    await p.$disconnect();
  }
});
test.afterAll(async ({ request }) => {
  rmSync(path.join(DATA_DIR, ".team.json"), { force: true });
  await request.delete(`${CLOUD_URL}/__stub/team`).catch(() => {});
  await request.delete(`${CLOUD_URL}/__stub/extra`).catch(() => {});
  // 造的这几位同事要删掉：留着 acct_<云端账号> 那一行，本机就按它认「我」（lib/desktop/me.ts），
  // 它跑完是业务员，同一次跑的排版闸门进门就成了业务员，设置里没有「业务配置」（10-19 CI 同一个 config 先跑团队页再跑闸门撞到）
  const p = 连库();
  try {
    await p.user.deleteMany({ where: { id: { in: 成员们.map((m) => `acct_${m.accountId}`) } } });
  } finally {
    await p.$disconnect();
  }
  if (出处) { mkdirSync(出处, { recursive: true }); writeFileSync(path.join(出处, "桌面排版问题.json"), JSON.stringify(记录, null, 2)); }
});

for (const 宽 of 宽们) {
  test(`${宽} 宽：团队页四种状态不撑破、不出界、不被盖住`, async ({ page, request }) => {
    await page.setViewportSize({ width: 宽, height: 宽 >= 1536 ? 960 : 700 });

    // 1. 老板，还剩 3 天，设备满 3 台，有一台手机等着允许
    进了团队(true);
    await 设云端团队(request, 团队());
    await 设额外(page, 额外);
    await 进设置团队(page);
    await 量批准框(page, 宽);
    await 量整页(page, 宽, "老板-快到期");

    // 2. 到期暂停同步
    await 设云端团队(request, 团队({ paidUntil: "2026-10-15", 剩几天: 0, expired: true }));
    await 进设置团队(page);
    await 关批准框(page);
    await 量整页(page, 宽, "老板-已到期");

    // 3. 成员那台（不是建团队的人）
    await 设云端团队(request, 团队({ 我是建的人: false, 成员: 成员们.map((m) => ({ ...m, role: m.accountId === "acc_long" ? "owner" : "member" })) }));
    await 进设置团队(page);
    await 关批准框(page);
    await 量整页(page, 宽, "成员");

    // 4. 这台还没进团队、账号在云上有团队：建 / 加入 / 连接卡 + 价格表
    进了团队(false);
    await 设云端团队(request, 团队());
    await 进设置团队(page);
    await 关批准框(page);
    await 量整页(page, 宽, "未连上");
  });
}
