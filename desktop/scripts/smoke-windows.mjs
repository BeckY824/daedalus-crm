import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(path.join(desktop, ".smoke-data"), { recursive: true });
const root = fs.mkdtempSync(path.join(desktop, ".smoke-data", "运行 空格-"));
const executablePath = process.argv[2] || path.join(desktop, "dist/win-unpacked/Daedalus CRM.exe");
let identity = "windows-smoke";
// 隔离的云端契约替身：不注册真实账号，不调用付费模型。
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/account/policy") return res.end(JSON.stringify({ register: true, reset: true }));
  if (req.url === "/api/account/token") return res.end(JSON.stringify({ token: `smoke-device-${identity}`, account: { id: identity, name: "Windows 测试", contact: `${identity}@example.test` } }));
  if (req.url === "/api/gateway/v1/models") return res.end(JSON.stringify({ data: [] }));
  if (req.url === "/api/gateway/v1/credits") return res.end(JSON.stringify({ accountId: identity, 还剩: 30 }));
  if (req.url === "/team") { res.setHeader("Content-Type", "text/html"); return res.end("<h1>Team server connected</h1>"); }
  res.statusCode = 404; res.end("{}");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const cloud = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, CRM_DATA_ROOT: root, CRM_CLOUD_URL: cloud, CRM_UPDATE_URL: `${cloud}/updates`, CRM_UPDATE_FALLBACK_URL: `${cloud}/updates` };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ executablePath, env, timeout: 60000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await expect(page.locator('input[type="password"]')).toBeVisible();
  console.log("PASS: packaged app starts at cloud login");
  await page.locator('input:not([type="password"]):not([type="hidden"])').first().fill("smoke@example.test");
  await page.locator('input[type="password"]').fill("smoke-password");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("**/dashboard", { timeout: 60000 });
  await expect(page.locator(".rail")).toBeVisible();
  console.log("PASS: cloud login and local session");
  await expect(page.getByRole("heading", { name: "欢迎使用 Daedalus CRM" })).toBeVisible();
  await page.waitForFunction(() => {
    let el = document.querySelector(".start-h");
    if (!el) return false;
    while (el) { if (Number(getComputedStyle(el).opacity) < 0.99) return false; el = el.parentElement; }
    return true;
  });
  await page.screenshot({ path: path.join(root, "dashboard.png") });
  await page.getByRole("button", { name: "手动录一位" }).click();
  await page.getByLabel("客户姓名", { exact: true }).fill("Windows 验证客户");
  await page.getByLabel("联系电话", { exact: true }).fill("13800138001");
  await page.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText("Windows 验证客户", { exact: true }).first()).toBeVisible();
  console.log("PASS: customer creation through the packaged UI");
  for (const route of ["customers", "channels", "contacts", "opportunities", "follow-ups", "reports", "settings"]) {
    await page.goto(`${new URL(page.url()).origin}/${route}`);
    await expect(page.locator(".rail")).toBeVisible();
    if ((await page.locator("body").innerText()).includes("Application error")) throw new Error(`Failed route ${route}`);
  }
  console.log("PASS: CRM routes render with native Windows Prisma engine");
  const backup = path.join(root, "备份 空格.db");
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, backup);
  const result = await page.evaluate(() => window.desktopShell.backup());
  if (!fs.existsSync(backup)) throw new Error(`Backup missing: ${JSON.stringify(result)}`);
  console.log("PASS: SQLite backup to Chinese/space path");
  await page.evaluate((url) => window.desktopShell.useServer(url), `${cloud}/team`);
  await expect(page.getByRole("heading", { name: "Team server connected" })).toBeVisible();
  console.log("PASS: connect to remote server");
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu().items.flatMap((x) => x.submenu?.items || []).find((x) => x.label.startsWith("改用本机数据"));
    if (!item) throw new Error("Missing local mode menu");
    item.click();
  });
  await expect(page.locator(".rail")).toBeVisible({ timeout: 60000 });
  console.log("PASS: return to local CRM without losing account data");
  await app.close(); app = null;
  app = await electron.launch({ executablePath, env, timeout: 60000 });
  const restarted = await app.firstWindow();
  await expect(restarted.locator(".rail")).toBeVisible({ timeout: 60000 });
  console.log("PASS: restart restores login and local database");
  const accountFile = () => path.join(root, "accounts", JSON.parse(fs.readFileSync(path.join(root, "current.json"), "utf8")).key, "crm.db");
  const firstDb = accountFile();
  const db = new DatabaseSync(firstDb);
  db.prepare("INSERT OR REPLACE INTO Setting (key,value,updatedAt) VALUES ('smoke.marker','account A',0)").run();
  db.close();
  async function switchTo(id) {
    await restarted.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
    identity = id;
    await restarted.goto(`${new URL(restarted.url()).origin}/login`);
    await restarted.locator('input:not([type="password"]):not([type="hidden"])').first().fill(`${id}@example.test`);
    await restarted.locator('input[type="password"]').fill("smoke-password");
    await restarted.locator('button[type="submit"]').click();
    await expect(restarted.locator(".rail")).toBeVisible({ timeout: 60000 });
  }
  await switchTo("windows-smoke-b");
  const secondDb = accountFile();
  if (firstDb === secondDb) throw new Error("Account switch reused database");
  const second = new DatabaseSync(secondDb);
  const marker = second.prepare("SELECT value FROM Setting WHERE key='smoke.marker'").get();
  second.close();
  if (marker) throw new Error("Account A data leaked to B");
  await switchTo("windows-smoke");
  if (accountFile() !== firstDb) throw new Error("Account A data not restored");
  const original = new DatabaseSync(firstDb);
  const restored = original.prepare("SELECT value FROM Setting WHERE key='smoke.marker'").get();
  original.close();
  if (restored?.value !== "account A") throw new Error("Account A data lost");
  console.log("PASS: account A/B isolation and return to existing data");
  console.log(`Evidence: ${root}`);
} catch (error) {
  console.error(`Evidence: ${root}`);
  for (const log of ["server.log", "app.log"]) {
    const p = path.join(root, "logs", log);
    if (fs.existsSync(p)) console.error(fs.readFileSync(p, "utf8").slice(-6000));
  }
  throw error;
} finally {
  if (app) await app.close();
  server.close();
}
