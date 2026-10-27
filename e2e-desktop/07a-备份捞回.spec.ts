/**
 * 设置 → 桌面端 → 自动备份 →「只捞回删掉的客户」（2026-10-26，0.46.28，lib/sync/trash-backup.ts）。
 *
 * 壳不在：window.desktopShell.autoBackups 由用例在页面载入前装一个假的，列出真放在数据目录里的那份每天备份。
 * 先造一位带联系人的客户、备一份、再删掉，然后在最小窗口 1024×700 下：
 *   - 那一行「只捞回删掉的客户」「恢复」两个按钮都摆得下，排版不出问题
 *   - 弹窗里按谁删的分组列出那位客户（长名字不撑破），排版不出问题
 *   - 点「捞回」后客户和联系人回来，这段时间新录的客户还在
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { DATA_DIR } from "./env";
import { 盯控制台, 我的id, 进门, 连库 } from "./helpers";
import { 查排版, 说问题 } from "../e2e/layout-audit";

const 名 = "备份捞回·被删掉的老客户（名字故意起得很长，看弹窗里会不会把按钮挤出去）有限公司";
const 新录的 = "备份之后才录的客户";
const 日期 = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
const 文件 = `daily-${日期}.db`;
let 客户id = "";

test.beforeAll(async () => {
  const p = 连库();
  try {
    const 我 = await 我的id(p);
    const c = await p.customer.create({ data: { name: 名, phone: "13822227701", salesOwnerId: 我 } });
    客户id = c.id;
    await p.contact.create({ data: { customerId: c.id, name: "老客户的采购", phone: "13922227701" } });
    fs.mkdirSync(path.join(DATA_DIR, "backups"), { recursive: true });
    const 备份 = path.join(DATA_DIR, "backups", 文件);
    fs.rmSync(备份, { force: true });
    await p.$executeRawUnsafe(`VACUUM INTO '${备份.replace(/'/g, "''")}'`);
    await p.customer.delete({ where: { id: c.id } });
    await p.customer.create({ data: { name: 新录的, phone: "13822227702", salesOwnerId: 我 } });
  } finally {
    await p.$disconnect();
  }
});

test.afterAll(() => {
  fs.rmSync(path.join(DATA_DIR, "backups", 文件), { force: true });
});

test("1024×700：自动备份那一行摆得下两个按钮，弹窗列出被删的客户，捞回后客户和联系人回来、新录的还在", async ({ page }) => {
  const 问题 = 盯控制台(page);
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.addInitScript((x) => {
    (window as unknown as { desktopShell: unknown }).desktopShell = {
      version: async () => "e2e",
      diagnostics: async () => "",
      autoBackups: async () => [{ 文件名: x.文件, 类型: "每天", 时间: `${x.日期}T09:00:00+08:00`, 大小: 245_760 }],
      restoreAutoBackup: async () => ({ ok: false, error: "e2e 不整库恢复" }),
    };
  }, { 文件, 日期 });
  await 进门(page, "/settings?tab=desktop");
  if (/\/start$/.test(page.url())) {
    await page.getByRole("button", { name: /用通用销售开始/ }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await 进门(page, "/settings?tab=desktop");
  }
  // 单跑这一份时「已更新到」还没点过，会自己弹：弹了就关掉（同 10-壳与窗口）
  const 更新 = page.getByRole("dialog", { name: /已更新到/ });
  if (await 更新.waitFor({ state: "visible", timeout: 2_500 }).then(() => true, () => false)) {
    await 更新.getByRole("button", { name: /知\s*道\s*了/ }).click();
    await expect(更新).toBeHidden();
  }

  const 行 = page.locator(".auto-backups-list li").first();
  const 捞 = 行.getByRole("button", { name: "只捞回删掉的客户" });
  await expect(捞).toBeVisible();
  await expect(行.getByRole("button", { name: /恢\s*复/ })).toBeVisible();
  await 捞.scrollIntoViewIfNeeded();
  const 行问题 = await 查排版(page, { 范围: ".auto-backups" });
  expect(行问题, 说问题(行问题)).toEqual([]);

  await 捞.click();
  const 框 = page.getByTestId("backup-rescue");
  await expect(框).toContainText(名);
  await expect(框).toContainText("下面 1 条");
  const 框问题 = await 查排版(page, { 范围: ".ant-modal-container" });
  expect(框问题, 说问题(框问题)).toEqual([]);

  await 框.getByRole("button", { name: /捞\s*回/ }).first().click();
  await expect(page.locator(".ant-message")).toContainText("捞回了 1 位客户");
  await expect(框).toContainText("没有被删掉的");

  const p = 连库();
  try {
    expect(await p.customer.findUnique({ where: { id: 客户id } })).not.toBeNull();
    expect(await p.contact.count({ where: { customerId: 客户id } })).toBe(1);
    expect(await p.customer.count({ where: { name: 新录的 } })).toBe(1);
  } finally {
    await p.$disconnect();
  }
  await page.waitForTimeout(500);
  expect(问题).toEqual([]);
});
