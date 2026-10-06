/**
 * Mac 打包产物的真壳冒烟（2026-10-06 测试分期 D.1 / D.2）。
 *
 * e2e-desktop 那一套没有壳（next dev + 用例代办壳的事），Windows 的 smoke-windows.mjs 只在 CI 的 Windows 上跑。
 * 这一份照它的路子在本机 Mac 上驱真壳：云端登录门 → 选**外贸**模版 → 只填 WhatsApp 建客户 → 新建商机 → 转为订单
 * → 各页都画得出来 → 备份到带中文和空格的路径 → 关掉重开（登录、数据、停在上次那页都在）→ 两个账号互不串。
 *
 *   npm run build:server && npx electron-builder --mac --dir   # 出 dist/mac-arm64/Daedalus CRM.app
 *   node scripts/smoke-mac.mjs                                  # 或者把可执行文件路径当第一个参数
 *   CRM_SMOKE_DATA_ROOT=/某个/数据根 node scripts/smoke-mac.mjs   # D.3：拿一份老版本的数据根（复制件）起
 *
 * 云端是本进程里的替身（不注册真账号、不调付费模型）。证据（截图、日志）留在 .smoke-data/ 下，路径最后打印。
 */
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(path.join(desktop, ".smoke-data"), { recursive: true });
const 老数据根 = process.env.CRM_SMOKE_DATA_ROOT;
const root = 老数据根 || fs.mkdtempSync(path.join(desktop, ".smoke-data", "运行 空格-"));
const executablePath = process.argv[2] || path.join(desktop, "dist/mac-arm64/Daedalus CRM.app/Contents/MacOS/Daedalus CRM");
let identity = process.env.CRM_SMOKE_IDENTITY || "mac-smoke";
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/account/policy") return res.end(JSON.stringify({ register: true, reset: true }));
  if (req.url === "/api/account/token") return res.end(JSON.stringify({ token: `smoke-device-${identity}`, account: { id: identity, name: "Mac 测试", contact: `${identity}@example.test` } }));
  if (req.url === "/api/gateway/v1/models") return res.end(JSON.stringify({ data: [] }));
  if (req.url === "/api/gateway/v1/credits") return res.end(JSON.stringify({ accountId: identity, 还剩: 30 }));
  res.statusCode = 404; res.end("{}");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const cloud = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, CRM_DATA_ROOT: root, CRM_CLOUD_URL: cloud, CRM_UPDATE_URL: `${cloud}/updates`, CRM_UPDATE_FALLBACK_URL: `${cloud}/updates` };
delete env.ELECTRON_RUN_AS_NODE;

const 戳 = String(Date.now()).slice(-5);
const 客户名 = `Mac外贸客户${戳}`;
const 商机名 = `LED 屏询盘${戳}`;
const 单号 = `PI-MAC-${戳}`;
const 步骤 = [];
const 过 = (s) => { 步骤.push(s); console.log(`PASS: ${s}`); };

async function 登录(p, 邮箱) {
  await p.locator("#auth-email").fill(邮箱);
  await p.getByRole("button", { name: /继\s*续/ }).click();
  await p.locator('input[type="password"]').fill("smoke-password");
  await p.locator('button[type="submit"]').click();
}
/** 新库先选模版；老账号回来直接是主界面。可能再弹一次「这一版更新了这些」 */
async function 进主界面(p, 模版 = "外贸出口") {
  const 选 = p.getByRole("button", { name: new RegExp(`用${模版}开始`) });
  await expect(选.or(p.locator(".rail")).first()).toBeVisible({ timeout: 60000 });
  if (await 选.isVisible()) await 选.click();
  await expect(p.locator(".rail")).toBeVisible({ timeout: 60000 });
  return 关更新说明(p);
}
/** 「这一版更新了这些」弹了就关掉，返回弹没弹 */
async function 关更新说明(p) {
  const 知道了 = p.getByRole("button", { name: /知\s*道\s*了/ });
  return 知道了.waitFor({ timeout: 5000 }).then(async () => { await 知道了.click(); return true; }, () => false);
}
const 截图 = (p, 名) => p.screenshot({ path: path.join(root, `${名}.png`) }).catch(() => undefined);

let app;
try {
  app = await electron.launch({ executablePath, env, timeout: 60000 });
  let page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  const 已登录 = await page.locator(".rail").or(page.locator("#auth-email")).first().waitFor({ timeout: 60000 }).then(async () => page.locator(".rail").isVisible());
  if (!已登录) {
    await expect(page.locator("#auth-email")).toBeVisible();
    过("打包的应用起在云端登录门");
    await 登录(page, `${identity}@example.test`);
  }
  const 弹了更新说明 = await 进主界面(page);
  if (老数据根 && !弹了更新说明) throw new Error("老用户升级上来没弹「这一版更新了这些」");
  过(老数据根 ? "老数据根：升级后进了主界面，弹了一次「这一版更新了这些」" : "登录 + 新库选外贸模版进主界面");
  const origin = new URL(page.url()).origin;
  await 截图(page, "01-主界面");

  // D.3 老数据根：先数一下升级前就在的客户，后面核对一个不少
  // 第一次装、第一次登录：库建在 _未认领 里，下次启动才认领到账号目录（main.js「认领这份数据」那段），那时才有 current.json
  const 当前库 = () => {
    const 指针 = path.join(root, "current.json");
    return path.join(root, "accounts", fs.existsSync(指针) ? JSON.parse(fs.readFileSync(指针, "utf8")).key : "_未认领", "crm.db");
  };
  const 数 = (sql) => { const d = new DatabaseSync(当前库(), { readOnly: true }); try { return d.prepare(sql).get().n; } finally { d.close(); } };
  const 进来时客户数 = 数("SELECT count(*) n FROM Customer");

  if (老数据根) {
    // 老用户（make-old-root.mjs 用 0.46.14 造的）：老客户和老跟进都在，模版还是通用；在设置里切外贸——老用户真会走的就是这条
    await page.goto(`${origin}/customers`);
    for (const 名 of ["老用户客户甲", "老用户客户乙", "老用户客户丙"]) await expect(page.locator("main").getByRole("link", { name: 名 })).toBeVisible();
    await expect(page.locator(".rail").getByRole("link", { name: "订单", exact: true })).toHaveCount(0);
    await page.locator("main").getByRole("link", { name: "老用户客户甲" }).click();
    await expect(page.locator("main")).toContainText("老版本记的跟进：下周寄样");
    过("老用户：升级后老客户、老跟进都在，模版还是通用");
    await page.goto(`${origin}/settings?tab=business`);
    const 面板 = page.getByRole("tabpanel", { name: /^业务配置/ });
    await expect(面板).toBeVisible();
    await page.waitForLoadState("networkidle").catch(() => {});
    await 面板.getByRole("button", { name: "外贸出口", exact: true }).click();
    await 面板.locator(".biz-preset-todo").getByRole("button", { name: /保\s*存/ }).click();
    await expect(page.getByText("已保存，全站措辞已更新")).toBeVisible({ timeout: 15000 });
    过("老用户：设置里切到外贸");
  }

  // 外贸建客户：电话空着只填 WhatsApp
  await page.goto(`${origin}/customers`);
  await expect(page.locator(".rail").getByRole("link", { name: "订单", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /新建客户/ }).click();
  const 框 = page.getByRole("dialog", { name: "新建客户" });
  await 框.getByLabel("客户姓名").fill(客户名);
  await 框.getByLabel("WhatsApp").fill(`+971 50 88${戳}`);
  await 框.getByLabel("国家").fill("阿联酋");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden();
  await expect(page.locator("main").getByRole("link", { name: 客户名 })).toBeVisible();
  过("外贸：只填 WhatsApp 建客户");

  await page.goto(`${origin}/opportunities`);
  await page.getByRole("button", { name: /新建商机/ }).first().click();
  const 商框 = page.getByRole("dialog", { name: "新建商机" });
  await 商框.getByLabel("商机名称").fill(商机名);
  await 商框.getByLabel("所属客户").click();
  await 商框.getByLabel("所属客户").fill(客户名);
  await page.locator(".ant-select-item-option", { hasText: 客户名 }).click();
  await 商框.getByLabel("商机金额").fill("18000");
  const 负责人 = 商框.getByLabel("负责人");
  if (await 负责人.count()) { await 负责人.click(); await page.keyboard.press("Enter"); }
  await 商框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(商框).toBeHidden();
  await page.getByRole("button", { name: `${商机名} 的更多操作` }).click();
  await page.getByRole("menuitem", { name: "转为订单" }).click();
  const 单框 = page.getByRole("dialog", { name: "转为订单" });
  await 单框.getByLabel("订单号 / PI 号").fill(单号);
  await 单框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText(new RegExp(`订单 ${单号} 已建好`))).toBeVisible();
  过("外贸：新建商机 → 转为订单");

  for (const route of ["customers", "opportunities", "orders", "follow-ups", "overview", "settings", "dashboard"]) {
    await page.goto(`${origin}/${route}`);
    await expect(page.locator(".rail")).toBeVisible();
    if ((await page.locator("body").innerText()).includes("Application error")) throw new Error(`页面挂了：${route}`);
  }
  await page.goto(`${origin}/orders`);
  await expect(page.locator(".ant-table-row", { hasText: 单号 })).toContainText(客户名);
  await 截图(page, "02-订单一览");
  过("各页都画得出来，订单一览里有刚转的那单");

  const 备份 = path.join(root, "备份 空格.db");
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, 备份);
  const 备份结果 = await page.evaluate(() => window.desktopShell.backup());
  if (!fs.existsSync(备份)) throw new Error(`备份文件没出来：${JSON.stringify(备份结果)}`);
  const 备份库 = new DatabaseSync(备份, { readOnly: true });
  const 备份里 = 备份库.prepare("SELECT count(*) n FROM TradeOrder WHERE no = ?").get(单号).n;
  备份库.close();
  if (备份里 !== 1) throw new Error("备份里没有刚建的订单");
  过("备份到带中文和空格的路径，备份里有刚建的订单");

  // 停在订单一览上关掉，重开要回到这里（D-025 停在上次那页）
  await page.goto(`${origin}/orders`);
  await expect(page.locator(".ant-table-row", { hasText: 单号 })).toBeVisible();
  await app.close(); app = null;
  app = await electron.launch({ executablePath, env, timeout: 60000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await expect(page.locator(".rail")).toBeVisible({ timeout: 60000 });
  if (await 关更新说明(page)) throw new Error("重开又弹了一次「这一版更新了这些」（看过就该收）");
  await expect(page).toHaveURL(/\/orders/);
  await expect(page.locator(".ant-table-row", { hasText: 单号 })).toContainText(客户名);
  过("关掉重开：不用再登录、停在订单一览、数据都在");

  if (老数据根) {
    const 现在 = 数("SELECT count(*) n FROM Customer");
    if (现在 !== 进来时客户数 + 1) throw new Error(`客户数对不上：进来 ${进来时客户数}，又建了 1 位，现在 ${现在}`);
    const 完整 = (() => { const d = new DatabaseSync(当前库(), { readOnly: true }); try { return d.prepare("PRAGMA integrity_check").get().integrity_check; } finally { d.close(); } })();
    if (完整 !== "ok") throw new Error(`integrity_check：${完整}`);
    过(`老数据根：客户 ${现在} 位一位不少（含刚建的 1 位），integrity ok`);
  } else {
    // 两个账号互不串
    const 第一个库 = 当前库();
    const a = new DatabaseSync(第一个库);
    a.prepare("INSERT OR REPLACE INTO Setting (key,value,updatedAt) VALUES ('smoke.marker','account A',0)").run();
    a.close();
    async function 换账号(id) {
      await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
      identity = id;
      await page.goto(`${new URL(page.url()).origin}/login`);
      await 登录(page, `${id}@example.test`);
      await 进主界面(page, "通用销售");
    }
    await 换账号("mac-smoke-b");
    const 第二个库 = 当前库();
    if (第一个库 === 第二个库) throw new Error("换账号还用的是同一个库");
    const b = new DatabaseSync(第二个库, { readOnly: true });
    const 串了 = b.prepare("SELECT value FROM Setting WHERE key='smoke.marker'").get() || b.prepare("SELECT 1 x FROM Customer WHERE name = ?").get(客户名);
    b.close();
    if (串了) throw new Error("A 账号的数据串到了 B");
    await expect(page.locator(".rail").getByRole("link", { name: "订单", exact: true })).toHaveCount(0);
    await 换账号(identity = "mac-smoke");
    if (当前库() !== 第一个库) throw new Error("换回 A 没回到 A 的库");
    await page.goto(`${new URL(page.url()).origin}/orders`);
    await expect(page.locator(".ant-table-row", { hasText: 单号 })).toBeVisible();
    过("两个账号：B 是通用、看不到 A 的客户；换回 A，订单还在");
  }
  console.log(`\n全过 ${步骤.length} 步。证据：${root}`);
} catch (error) {
  console.error(`证据：${root}`);
  for (const log of ["server.log", "app.log"]) {
    const p = path.join(root, "logs", log);
    if (fs.existsSync(p)) console.error(fs.readFileSync(p, "utf8").slice(-6000));
  }
  throw error;
} finally {
  if (app) await app.close();
  server.close();
}
