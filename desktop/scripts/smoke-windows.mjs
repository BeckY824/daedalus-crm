import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { spawn, execFileSync } from "node:child_process";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(path.join(desktop, ".smoke-data"), { recursive: true });
const installedRoot = process.env.CRM_SMOKE_DATA_ROOT;
if (installedRoot && (process.env.GITHUB_ACTIONS !== "true" || path.resolve(installedRoot) !== path.resolve(process.env.APPDATA, "DaedalusCRM") || fs.existsSync(installedRoot))) {
  throw new Error("Default-root smoke is allowed only in a fresh GitHub Actions runner");
}
const root = installedRoot || fs.mkdtempSync(path.join(desktop, ".smoke-data", "运行 空格-"));
fs.mkdirSync(root, { recursive: true });
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
// 首次登录尚未重启时，数据库还在未认领目录；重启才写账号指针。
const accountFile = () => {
  const pointer = path.join(root, "current.json");
  const key = fs.existsSync(pointer) ? JSON.parse(fs.readFileSync(pointer, "utf8")).key : "_未认领";
  return path.join(root, "accounts", key, "crm.db");
};
/**
 * 0.46.15 的新登录门：先填邮箱点「继续」，云端说是老号才出密码框。
 * 这个替身没有「注册开始」接口、回 404——桌面端当成老云端，直接去输密码（H-055），正好走登录这条
 */
async function 登录(p, 邮箱) {
  // SSR 的输入框先于 React 事件处理器出现。差量重启后的热启动更快，
  // 不能把「看见邮箱框」当成表单已就绪；与 desktop E2E 一样等首轮资源加载结束。
  await p.waitForLoadState("networkidle");
  await p.locator("#auth-email").fill(邮箱);
  await p.getByRole("button", { name: /继\s*续/ }).click();
  await p.locator('input[type="password"]').fill("smoke-password");
  await p.locator('button[type="submit"]').click();
}
/**
 * 新库第一次进门先选模版（通用 / 外贸），进了主界面可能再弹一次「这一版更新了这些」。
 * 不看网址：老账号回来落在他上次停的那一页（D-025，比如数据页），不一定是 /dashboard
 */
async function 进主界面(p) {
  const 模版 = p.getByRole("button", { name: /用通用销售开始/ });
  await expect(模版.or(p.locator(".rail")).first()).toBeVisible({ timeout: 60000 });
  if (await 模版.isVisible()) await 模版.click();
  await expect(p.locator(".rail")).toBeVisible({ timeout: 60000 });
  const 知道了 = p.getByRole("button", { name: /知\s*道\s*了/ });
  await 知道了.waitFor({ timeout: 5000 }).then(() => 知道了.click(), () => undefined);
}
let app;
try {
  app = await electron.launch({ executablePath, env, timeout: 60000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await expect(page.locator("#auth-email")).toBeVisible();
  console.log("PASS: packaged app starts at cloud login");
  await 登录(page, "smoke@example.test");
  await 进主界面(page);
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

  /*
    外贸一圈（2026-10-06 测试分期 D：Mac 上 scripts/smoke-mac.mjs 跑通的同一段）：设置里切外贸 → 只填 WhatsApp 建客户
    → 新建商机 → 转为订单 → 订单一览里有。这一份只在 Windows CI 上跑，Sam 手上的包从此也验过外贸
  */
  await page.goto(`${origin}/settings?tab=business`);
  const 业务面板 = page.getByRole("tabpanel", { name: /^业务配置/ });
  await expect(业务面板).toBeVisible();
  await page.waitForLoadState("networkidle").catch(() => {});
  await 业务面板.getByRole("button", { name: "外贸出口", exact: true }).click();
  await 业务面板.locator(".biz-preset-todo").getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText("已保存，全站措辞已更新")).toBeVisible({ timeout: 15000 });
  await page.goto(`${origin}/customers`);
  await expect(page.locator(".rail").getByRole("link", { name: "订单", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /新建客户/ }).click();
  const 外贸框 = page.getByRole("dialog", { name: "新建客户" });
  await 外贸框.getByLabel("客户姓名").fill("Windows 外贸客户");
  await 外贸框.getByLabel("WhatsApp").fill("+971 50 765 0001");
  await 外贸框.getByLabel("国家").fill("阿联酋");
  await 外贸框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(外贸框).toBeHidden();
  await page.goto(`${origin}/opportunities`);
  await page.getByRole("button", { name: /新建商机/ }).first().click();
  const 商框 = page.getByRole("dialog", { name: "新建商机" });
  await 商框.getByLabel("商机名称").fill("Windows LED 询盘");
  await 商框.getByLabel("所属客户").click();
  await 商框.getByLabel("所属客户").fill("Windows 外贸客户");
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option:not(.ant-select-item-option-disabled)", { hasText: "Windows 外贸客户" }).click();
  await expect(商框.locator(".ant-select-content-has-value").filter({ hasText: "Windows 外贸客户" })).toBeVisible();
  await 商框.getByLabel("商机金额").fill("18000");
  const 负责人 = 商框.getByLabel("负责人");
  if (await 负责人.count()) { await 负责人.click(); await page.keyboard.press("Enter"); }
  await 商框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(商框).toBeHidden();
  const selectedDb = new DatabaseSync(accountFile(), { readOnly: true });
  try {
    const link = selectedDb.prepare('SELECT c.name FROM Opportunity o JOIN Customer c ON c.id=o.customerId WHERE o.name=?').get("Windows LED 询盘");
    if (link?.name !== "Windows 外贸客户") throw new Error("商机未保存到选择的外贸客户");
  } finally { selectedDb.close(); }
  await page.getByRole("button", { name: "Windows LED 询盘 的更多操作" }).click();
  await page.getByRole("menuitem", { name: "转为订单" }).click();
  const 单框 = page.getByRole("dialog", { name: "转为订单" });
  await 单框.getByLabel("订单号 / PI 号").fill("PI-WIN-01");
  await 单框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText(/订单 PI-WIN-01 已建好/)).toBeVisible();
  await page.goto(`${origin}/orders`);
  await expect(page.locator("main .ant-table-row:visible", { hasText: "PI-WIN-01" })).toContainText("Windows 外贸客户");
  console.log("PASS: trade template — WhatsApp-only customer, opportunity → order, order list");
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
  const firstDb = accountFile();
  const db = new DatabaseSync(firstDb);
  db.prepare("INSERT OR REPLACE INTO Setting (key,value,updatedAt) VALUES ('smoke.marker','account A',0)").run();
  db.close();
  async function switchTo(id) {
    await restarted.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
    identity = id;
    await restarted.goto(`${new URL(restarted.url()).origin}/login`);
    await 登录(restarted, `${id}@example.test`);
    await 进主界面(restarted);
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
  if (app) {
    for (const [i, p] of app.windows().entries()) {
      await p.screenshot({ path: path.join(root, `failure-${i}.png`) }).catch(() => {});
      console.error(`Window ${i}: ${p.url()}\n${await p.locator("body").innerText().catch(() => "（窗口不可读）")}`);
    }
  }
  for (const log of ["server.log", "app.log"]) {
    const p = path.join(root, "logs", log);
    if (fs.existsSync(p)) console.error(fs.readFileSync(p, "utf8").slice(-6000));
  }
  throw error;
} finally {
  if (app) await app.close();
  server.close();
}
