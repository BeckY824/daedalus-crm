/**
 * 用本机装着的**正式版**（/Applications，0.46.14）在一个隔离的数据根里当一回老用户（2026-10-06 测试分期 D.3）：
 * 登录（本机云端替身，不碰真账号）→ 界面上录 3 位客户、记一笔跟进 → 关掉再开一次（第二次启动才把库认领进账号目录）→ 关掉。
 * 打印出数据根，交给 smoke-mac.mjs 用新包打开：
 *
 *   node scripts/make-old-root.mjs                      # 或者把老版本可执行文件当第一个参数
 *   CRM_SMOKE_DATA_ROOT=<上面打印的> CRM_SMOKE_IDENTITY=mac-old node scripts/smoke-mac.mjs
 *
 * 用户真实的数据目录一个字节都不碰（CRM_DATA_ROOT 挪走了数据根和单实例锁）。
 */
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executablePath = process.argv[2] || "/Applications/Daedalus CRM.app/Contents/MacOS/Daedalus CRM";
const root = path.join(desktop, ".smoke-data", `老用户 0.46.14-${String(Date.now()).slice(-5)}`);
fs.mkdirSync(root, { recursive: true });
const identity = "mac-old";
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/account/policy") return res.end(JSON.stringify({ register: true, reset: true }));
  if (req.url === "/api/account/token") return res.end(JSON.stringify({ token: `smoke-device-${identity}`, account: { id: identity, name: "老用户", contact: `${identity}@example.test` } }));
  if (req.url === "/api/gateway/v1/models") return res.end(JSON.stringify({ data: [] }));
  if (req.url === "/api/gateway/v1/credits") return res.end(JSON.stringify({ accountId: identity, 还剩: 30 }));
  res.statusCode = 404; res.end("{}");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const cloud = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, CRM_DATA_ROOT: root, CRM_CLOUD_URL: cloud, CRM_UPDATE_URL: `${cloud}/updates`, CRM_UPDATE_FALLBACK_URL: `${cloud}/updates` };
delete env.ELECTRON_RUN_AS_NODE;

let app;
try {
  app = await electron.launch({ executablePath, env, timeout: 60000 });
  let page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await expect(page.locator('input[type="password"]')).toBeVisible({ timeout: 60000 });
  await page.locator('input:not([type="password"]):not([type="hidden"])').first().fill(`${identity}@example.test`);
  await page.locator('input[type="password"]').fill("smoke-password");
  await page.locator('button[type="submit"]').click();
  await expect(page.locator(".rail")).toBeVisible({ timeout: 60000 });
  const origin = new URL(page.url()).origin;
  for (const [名, 号] of [["老用户客户甲", "13900001001"], ["老用户客户乙", "13900001002"], ["老用户客户丙", "13900001003"]]) {
    await page.goto(`${origin}/customers`);
    await page.getByRole("button", { name: /新建客户/ }).click();
    const 框 = page.getByRole("dialog", { name: "新建客户" });
    await 框.getByLabel("客户姓名").fill(名);
    await 框.getByLabel("联系电话").fill(号);
    await 框.getByRole("button", { name: /保\s*存/ }).click();
    await expect(框).toBeHidden();
    await expect(page.locator("main").getByRole("link", { name: 名 })).toBeVisible();
  }
  await page.locator("main").getByRole("link", { name: "老用户客户甲" }).click();
  await page.waitForURL(/\/customers\/[^/?]+/);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.getByPlaceholder(/记一笔/).first().fill("老版本记的跟进：下周寄样");
  await page.getByRole("button", { name: "直接记" }).click();
  await expect(page.locator("main").getByText("老版本记的跟进：下周寄样")).toBeVisible();
  console.log("PASS: 0.46.14 登录、录 3 位客户、记 1 笔跟进");
  await app.close(); app = null;

  // 第二次启动：老版本在这一次把 _未认领 的库认领进账号目录（和真用户第二天再开一样）
  app = await electron.launch({ executablePath, env, timeout: 60000 });
  page = await app.firstWindow();
  await expect(page.locator(".rail")).toBeVisible({ timeout: 60000 });
  await page.goto(`${new URL(page.url()).origin}/customers`);
  await expect(page.locator("main").getByRole("link", { name: "老用户客户丙" })).toBeVisible();
  console.log("PASS: 0.46.14 重开，数据在");
  await app.close(); app = null;
  if (!fs.existsSync(path.join(root, "current.json"))) throw new Error("老版本重开后没有 current.json（没认领？）");
  console.log(`老数据根：${root}`);
} finally {
  if (app) await app.close();
  server.close();
}
