/**
 * 系统开了「减弱动态效果」，弹层照样出现在按钮旁边（GitHub issue #1，2026-10-02 用户报）。
 * globals.css 的 reduced-motion 块只把 transition-duration 改成 0.01ms，transition-property 还是初始值 all，
 * 等于每个元素都带上 transition: all。rc-trigger 定位时先把 left/top 归零、紧接着同步量一次位置，
 * 量到的还是归零前的 -1000vw，菜单整个落到屏幕外——用户看到的是「点了没反应」。
 */
import { test, expect, type Page } from "@playwright/test";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };

test.use({ viewport: { width: 1264, height: 800 } });

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

/** 弹层的框整个落在视口里 */
async function 在屏幕里(page: Page, 选择器: string, 哪个: string) {
  const 层 = page.locator(`${选择器}:not(${选择器}-hidden)`).last();
  await expect(层, `${哪个}：该出现`).toBeVisible();
  await expect
    .poll(
      () =>
        层.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight ? "ok" : `落在 ${Math.round(r.left)},${Math.round(r.top)}`;
        }),
      { message: `${哪个}：要在屏幕里，不在 -1000vw` },
    )
    .toBe("ok");
}

test("减弱动态效果：账号菜单、下拉框都出现在按钮旁边", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await 登录(page);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

  await page.getByRole("button", { name: /账号菜单/ }).last().click();
  await 在屏幕里(page, ".ant-dropdown", "账号菜单");
  await expect(page.getByText("退出登录")).toBeVisible();
  await page.keyboard.press("Escape");

  // 弹层根节点不该带 transition：带了 rc-trigger 就会量错位置
  const 带过渡的 = await page.evaluate(() => {
    const 根 = [".ant-dropdown", ".ant-select-dropdown", ".ant-picker-dropdown", ".ant-tooltip", ".ant-popover", ".ant-cascader-dropdown", ".ant-mentions-dropdown", ".ant-tour"];
    return 根.filter((c) => {
      const d = document.createElement("div");
      d.className = c.slice(1);
      document.body.appendChild(d);
      const p = getComputedStyle(d).transitionProperty;
      d.remove();
      return p !== "none";
    });
  });
  expect(带过渡的).toEqual([]);
});
