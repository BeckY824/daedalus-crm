import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { spawn, execFileSync } from "node:child_process";

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
  const origin = new URL(page.url()).origin;
  for (const route of ["customers", "channels", "contacts", "opportunities", "follow-ups", "overview", "settings"]) {
    await page.goto(`${origin}/${route}`);
    await expect(page.locator(".rail")).toBeVisible();
    if ((await page.locator("body").innerText()).includes("Application error")) throw new Error(`Failed route ${route}`);
  }
  // /reports 是旧地址，服务端 redirect 到 /overview。页面已经开始流式输出时 Next 改走客户端跳转——
  // goto 先返回、跳转随后才发生，紧接着的下一次 goto 会撞上它（0.46.8 首次 CI 偶发红就是这个）。所以单独等它落地
  await page.goto(`${origin}/reports`);
  await page.waitForURL("**/overview**");
  await expect(page.locator(".rail")).toBeVisible();
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

  /*
    整包静默安装进行中时点开应用（2026-09-29 Sam 那台的起点）：程序文件可能写了一半，
    不能起本地服务，要开小窗说明情况；安装程序退出后从新文件重开。
    用一个空跑的 node 进程冒充安装程序，版本写一个本进程肯定不是的号。
  */
  await app.close(); app = null;
  const 服务启动次数 = () => (fs.readFileSync(path.join(root, "logs", "server.log"), "utf8").match(/启动 =====/g) || []).length;
  const 假安装 = spawn(process.execPath, ["-e", "setTimeout(() => {}, 180000)"], { stdio: "ignore" });
  const 记录 = path.join(root, "updates", "installing.json");
  fs.mkdirSync(path.dirname(记录), { recursive: true });
  fs.writeFileSync(记录, JSON.stringify({ 版本: "9.9.9", pid: 假安装.pid, at: Date.now() }));
  const 之前 = 服务启动次数();
  app = await electron.launch({ executablePath, env, timeout: 60000 });
  const 小窗 = await app.firstWindow();
  await expect(小窗.getByText("正在安装 9.9.9")).toBeVisible({ timeout: 30000 });
  await new Promise((r) => setTimeout(r, 5000));
  if (服务启动次数() !== 之前) throw new Error("安装还没结束，本地服务就起了");
  console.log("PASS: opening the app mid-install waits instead of starting a half-written app");
  // 安装程序退出 → 应用 relaunch。重开的是新进程，Playwright 接管不到：看日志和记录，最后只收测试路径的进程。
  假安装.kill();
  const 截止 = Date.now() + 120000;
  while ((服务启动次数() === 之前 || fs.existsSync(记录)) && Date.now() < 截止) await new Promise((r) => setTimeout(r, 1000));
  if (服务启动次数() === 之前) throw new Error("安装程序退出后应用没有重新打开");
  if (fs.existsSync(记录)) throw new Error("安装记录没清掉");
  console.log("PASS: after the installer exits the app relaunches from the installed files");
  app = null;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$target = [IO.Path]::GetFullPath($env:CRM_SMOKE_EXE); Get-Process | Where-Object { $_.Path -eq $target } | Stop-Process -Force",
    ], { stdio: "ignore", windowsHide: true, env: { ...process.env, CRM_SMOKE_EXE: path.resolve(executablePath) } });
  } catch { /* 已经没了 */ }

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
