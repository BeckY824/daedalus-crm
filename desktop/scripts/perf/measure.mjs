#!/usr/bin/env node
/**
 * 桌面端性能测量：拉起一份**装好的**桌面端（独立数据根 + 假云端），量冷启动、各进程内存、各页出页时间。
 * Mac 和 Windows 同一套流程，CI（.github/workflows/perf-measure.yml）和本机都跑它，优化前后的数字才对得上。
 *
 *   node desktop/scripts/perf/measure.mjs --exe <可执行文件> --app <安装目录或 .app> --out <输出目录>
 *
 * 流程：
 *   1. 新数据根，第一次启动（冷启动，要建库）→ 停在登录页
 *   2. 写入登录过云端的凭据（假云端），第二次启动 → 选模版进首页（空库）
 *   3. 往库里造 1 万客户 / 2 万跟进 / 1000 商机
 *   4. 第三次启动：首页空闲、客户列表、AI 面板、站内切页 40 次、整页刷新 20 次、空闲 2 分钟、各页出页时间
 *
 * 内存口径：Mac 用 `footprint`（= 活动监视器的「内存」），Windows 用 getAppMetrics 的 privateBytes（≈ 任务管理器）。
 * 另记 workingSetSize（常驻内存，含共享部分，偏大）。
 * 不碰用户真实的数据目录（CRM_DATA_ROOT），不花真钱（假云端只回固定话）。
 */
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const 仓库 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(仓库, "package.json"));
const { _electron } = require("@playwright/test");

const 参数 = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const exe = path.resolve(参数.exe);
const 输出 = path.resolve(参数.out);
const 云端口 = Number(参数.port || 3901);
const 云 = `http://127.0.0.1:${云端口}`;
const 数据根 = path.join(输出, "data-root");
fs.rmSync(数据根, { recursive: true, force: true });
fs.mkdirSync(数据根, { recursive: true });

const 结果 = { platform: process.platform, arch: process.arch, exe, at: new Date().toISOString() };
const 存 = () => fs.writeFileSync(path.join(输出, "result.json"), JSON.stringify(结果, null, 2));
const 等 = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 磁盘占用 ---------- */
function 目录大小(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((s, n) => s + 目录大小(path.join(p, n)), 0);
}
const MB = (b) => +(b / 1048576).toFixed(1);
if (参数.app) {
  const app = path.resolve(参数.app);
  const 拆 = (d) => (fs.existsSync(d) ? Object.fromEntries(fs.readdirSync(d).map((n) => [n, MB(目录大小(path.join(d, n)))]).sort((a, b) => b[1] - a[1]).slice(0, 15)) : null);
  const server = process.platform === "darwin" ? path.join(app, "Contents/Resources/server") : path.join(app, "resources/server");
  const 按后缀 = {};
  (function 走(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) 走(p);
      else if (e.isFile()) {
        const k = e.name.endsWith(".nft.json") ? ".nft.json" : path.extname(e.name) || "(无)";
        按后缀[k] = (按后缀[k] ?? 0) + fs.statSync(p).size;
      }
    }
  })(server);
  结果.disk = {
    totalMB: MB(目录大小(app)),
    top: 拆(process.platform === "darwin" ? path.join(app, "Contents") : app),
    serverTop: 拆(server),
    serverNodeModules: 拆(path.join(server, "node_modules")),
    serverByExt: Object.fromEntries(Object.entries(按后缀).map(([k, v]) => [k, MB(v)]).sort((a, b) => b[1] - a[1]).slice(0, 12)),
    localesMB: process.platform === "win32" ? MB(目录大小(path.join(app, "locales"))) : null,
  };
  console.log("disk", JSON.stringify(结果.disk));
  存();
}

/* ---------- 假云端 ---------- */
const 桩 = spawn(process.execPath, [path.join(仓库, "e2e-desktop/cloud-stub.mjs")], { env: { ...process.env, CLOUD_PORT: String(云端口) }, stdio: "ignore" });
for (let i = 0; i < 50; i++) {
  if (await fetch(`${云}/__stub/health`).then((r) => r.ok, () => false)) break;
  await 等(200);
}

const env = { ...process.env, CRM_DATA_ROOT: 数据根, CRM_CLOUD_URL: 云, CRM_UPDATE_URL: `${云}/nope`, CRM_UPDATE_FALLBACK_URL: `${云}/nope` };
delete env.ELECTRON_RUN_AS_NODE;

function 足迹(pid) {
  if (process.platform !== "darwin") return null;
  try {
    const t = execFileSync("footprint", ["-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = t.match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/);
    if (!m) return null;
    const v = Number(m[1]);
    return +(m[2] === "GB" ? v * 1024 : m[2] === "KB" ? v / 1024 : v).toFixed(1);
  } catch { return null; }
}

async function 内存(app, 标签) {
  const ms = await app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.serviceName || m.name || "", ws: m.memory.workingSetSize, priv: m.memory.privateBytes ?? null })));
  const 行 = ms.map((m) => {
    const 类 = m.type === "Browser" ? "主进程" : m.type === "GPU" ? "GPU" : m.type === "Tab" ? "页面" : /Node/i.test(m.name) ? "本地服务" : /Network/i.test(m.name) ? "网络" : m.type;
    const 主口径 = process.platform === "darwin" ? 足迹(m.pid) : m.priv != null ? +(m.priv / 1024).toFixed(1) : null;
    return { 类, pid: m.pid, MB: 主口径, wsMB: +(m.ws / 1024).toFixed(1) };
  });
  const 合计 = +行.reduce((s, r) => s + (r.MB ?? 0), 0).toFixed(1);
  const 合计ws = +行.reduce((s, r) => s + r.wsMB, 0).toFixed(1);
  (结果.memory ??= {})[标签] = { 行, 合计, 合计ws };
  console.log("mem", 标签, 行.map((r) => `${r.类}=${r.MB}`).join(" "), "合计", 合计, "ws", 合计ws);
  存();
}

async function 启动(标签) {
  const t0 = Date.now();
  const app = await _electron.launch({ executablePath: exe, env, timeout: 180_000 });
  const 起 = { launch: Date.now() - t0 };
  await app.firstWindow({ timeout: 180_000 });
  起.firstWindow = Date.now() - t0;
  let page;
  for (let i = 0; i < 720 && !page; i++) {
    page = app.windows().find((w) => /127\.0\.0\.1:\d+\/(?!api)/.test(w.url()));
    if (!page) await 等(250);
  }
  if (!page) throw new Error(`${标签}：3 分钟内没等到本地服务的页面`);
  await page.waitForLoadState("load").catch(() => {});
  起.pageLoad = Date.now() - t0;
  起.path = new URL(page.url()).pathname;
  (结果.startup ??= {})[标签] = 起;
  console.log("startup", 标签, JSON.stringify(起));
  return { app, page, t0 };
}

const 账号目录 = () => {
  const d = path.join(数据根, "accounts");
  const 有库 = fs.readdirSync(d).map((n) => path.join(d, n)).filter((p) => fs.existsSync(path.join(p, "crm.db")));
  if (有库.length !== 1) throw new Error(`accounts 下应当正好一份库，实际 ${有库.length}`);
  return 有库[0];
};

try {
  /* 1. 冷启动到登录页 */
  {
    const { app, page } = await 启动("冷启动·新装建库");
    await page.waitForLoadState("networkidle").catch(() => {});
    await 等(5000);
    await 内存(app, "登录页");
    await app.close();
  }

  /* 2. 当成登录过云端：凭据和 .owner 写进数据目录，选模版进首页 */
  {
    const d = 账号目录();
    fs.writeFileSync(path.join(d, ".cloud.json"), JSON.stringify({ baseUrl: 云, token: "dk_e2e_device_token", accountId: "acc_e2e", name: "林小雨", contact: "xiaoyu@example.com", models: ["e2e-model|默认"], loggedAt: new Date().toISOString() }), { mode: 0o600 });
    fs.writeFileSync(path.join(d, ".owner"), "acc_e2e", { mode: 0o600 });
    const { app, page, t0 } = await 启动("热启动·空库");
    await page.waitForURL(/\/start$/, { timeout: 60_000 });
    await page.getByRole("button", { name: /用通用销售开始/ }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
    await page.locator("nav.rail").first().waitFor({ timeout: 60_000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    结果.startup["热启动·空库"].dashboardReady = Date.now() - t0;
    await 等(15_000);
    await 内存(app, "空库首页");
    await app.close();
  }

  /* 3. 造数据 */
  {
    const db = path.join(账号目录(), "crm.db");
    const t = Date.now();
    const tsx = path.join(仓库, "node_modules/tsx/dist/cli.mjs");
    execFileSync(process.execPath, [tsx, path.join(仓库, "desktop/scripts/perf/seed.ts")], { cwd: 仓库, env: { ...process.env, DATABASE_URL: `file:${db.replaceAll("\\", "/")}` }, stdio: "inherit" });
    结果.seedMs = Date.now() - t;
  }

  /* 4. 1 万客户 */
  {
    const { app, page, t0 } = await 启动("热启动·1万客户");
    const base = new URL(page.url()).origin;
    await page.goto(`${base}/dashboard`);
    await page.locator("nav.rail").first().waitFor({ timeout: 60_000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    结果.startup["热启动·1万客户"].dashboardReady = Date.now() - t0;
    结果.dashboardResources = await page.evaluate(() => {
      const es = performance.getEntriesByType("resource");
      const s = (a, k) => Math.round(a.reduce((x, e) => x + (e[k] || 0), 0) / 1024);
      const js = es.filter((e) => /\.js(\?|$)/.test(e.name));
      const css = es.filter((e) => /\.css(\?|$)/.test(e.name));
      return { jsCount: js.length, jsKB: s(js, "decodedBodySize"), cssCount: css.length, cssKB: s(css, "decodedBodySize"), domNodes: document.getElementsByTagName("*").length, viewport: `${innerWidth}x${innerHeight}` };
    });
    console.log("res", JSON.stringify(结果.dashboardResources));
    await 等(30_000);
    await 内存(app, "首页空闲");

    const cdp = await page.context().newCDPSession(page);
    const 堆 = async () => { await cdp.send("HeapProfiler.collectGarbage"); return Math.round((await cdp.send("Runtime.getHeapUsage")).usedSize / 1048576); };

    // 站内点链接切页（和用户一样，走客户端路由）。桌面端左栏「客户」去的是 /customers/recent（名单 + 详情），
    // 表格视图 /customers 从名单顶上那个「表格视图」进
    const 点 = async (href) => {
      // 找入口不算进切页时间（原来先干等 10 秒链接、还算进了耗时，1024 宽时表格切页量出 10 秒）
      const 链接 = page.locator(`a[href="${href}"]:visible`).first();
      // runner 的屏幕小，窗口被压窄时名单收成抽屉，「表格视图」在抽屉里：像人一样先点主区页头那颗侧栏图标打开
      const 开抽屉 = page.locator('button.pane-toggle[aria-expanded="false"]:visible').first();
      // 链接和收起后的图标谁先出来用谁，不干等；都没有才等满 10 秒
      await 链接.or(开抽屉).first().waitFor({ timeout: 10_000 }).catch(() => {});
      let 有 = await 链接.isVisible();
      if (!有 && (await 开抽屉.isVisible())) {
        await 开抽屉.click();
        有 = await 链接.waitFor({ timeout: 3000 }).then(() => true, () => false);
        if (有) 结果.navDrawer = [...(结果.navDrawer ?? []), href];
      }
      let t = Date.now();
      // 碰上中栏正在收起，链接点不到：别让 Playwright 一直等，改走路由
      if (有) 有 = await 链接.click({ timeout: 5000 }).then(() => true, () => false);
      if (!有) {
        // 还是找不到入口就直接走 Next 自己的客户端路由，和点链接走的是同一条路
        t = Date.now();
        await page.evaluate((h) => window.next.router.push(h), href);
        结果.navFallback = [...(结果.navFallback ?? []), href];
      }
      // /customers/recent 会再跳到 /customers/<最近那位>，等落到详情页为止
      const 到了 = href === "/customers/recent" ? (u) => /^\/customers\/(?!recent$)[^/]+$/.test(u.pathname) : (u) => u.pathname + u.search === href;
      await page.waitForURL(到了, { timeout: 60_000 }).catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
      return Date.now() - t;
    };
    await 点("/customers/recent");
    结果.customersTableNavMs = await 点("/customers");
    await 等(10_000);
    await 内存(app, "客户表格");
    结果.heap = { 客户表格: await 堆() };

    // AI 面板
    try {
      await page.getByRole("button", { name: /打开 AI 面板/ }).click({ timeout: 8000 });
      await page.locator("aside.dock").waitFor({ timeout: 8000 });
      await 等(8000);
      await 内存(app, "AI面板开着");
      await page.getByRole("button", { name: "关闭 AI 面板" }).click().catch(() => {});
    } catch (e) { 结果.aiError = String(e).slice(0, 300); }

    // 站内切页 40 次 + 数后台请求
    const 路 = ["/dashboard", "/customers/recent", "/customers", "/follow-ups", "/opportunities"];
    const 请求 = [];
    const 记请求 = (r) => 请求.push(`${r.method()} ${new URL(r.url()).pathname.replace(/\/customers\/c[a-z0-9]+/, "/customers/<id>")}`);
    page.on("request", 记请求);
    const 切页 = [];
    const 堆们 = [await 堆()];
    for (let i = 0; i < 40; i++) {
      const href = 路[i % 路.length];
      切页.push([href, await 点(href)]);
      if (i % 10 === 9) 堆们.push(await 堆());
    }
    page.off("request", 记请求);
    const 中位 = (h) => { const a = 切页.filter((x) => x[0] === h).map((x) => x[1]).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
    结果.navMedianMs = Object.fromEntries(路.map((h) => [h, 中位(h)]));
    结果.heap.站内切页 = 堆们;
    const 数 = {};
    for (const r of 请求) if (!r.includes("/_next/static/")) 数[r] = (数[r] ?? 0) + 1;
    结果.navRequests = 数;
    console.log("nav", JSON.stringify(结果.navMedianMs), "heap", 堆们.join("/"), "detailPrefetch", 数["GET /customers/<id>"] ?? 0);
    await 内存(app, "切页40次后");

    // 整页刷新 20 次
    const 堆2 = [];
    for (let i = 0; i < 20; i++) {
      await page.goto(`${base}${路[i % 路.length]}`);
      await page.waitForLoadState("networkidle").catch(() => {});
      if (i % 5 === 4) 堆2.push(await 堆());
    }
    let t;
    结果.heap.整页刷新 = 堆2;
    await 内存(app, "整页刷新20次后");

    // 空闲 2 分钟：后台有没有在跑
    const 空闲请求 = [];
    const 记空闲 = (r) => 空闲请求.push(`${r.method()} ${new URL(r.url()).pathname}`);
    await page.goto(`${base}/dashboard`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await fetch(`${云}/__stub/reset`);
    page.on("request", 记空闲);
    await 等(120_000);
    page.off("request", 记空闲);
    const 闲 = {};
    for (const r of 空闲请求) 闲[r] = (闲[r] ?? 0) + 1;
    结果.idle2min = { 本地: 闲, 云端: await fetch(`${云}/__stub/stats`).then((r) => r.json()) };
    await 内存(app, "空闲2分钟后");

    // 各页服务端出页时间、页面大小（三次取中位）
    结果.pages = {};
    for (const p of ["/dashboard", "/customers/recent", "/customers", "/follow-ups", "/opportunities", "/contacts", "/overview", "/settings"]) {
      const ts = [];
      let kb = 0;
      for (let i = 0; i < 3; i++) {
        t = Date.now();
        const r = await page.request.get(base + p);
        kb = Math.round((await r.body()).length / 1024);
        ts.push(Date.now() - t);
      }
      const r = await page.request.get(`${base}${p}?_rsc=perf`, { headers: { RSC: "1" } });
      结果.pages[p] = { ms: ts.sort((a, b) => a - b)[1], htmlKB: kb, rscKB: Math.round((await r.body()).length / 1024) };
    }
    console.log("pages", JSON.stringify(结果.pages));
    存();
    await app.close();
  }
} finally {
  桩.kill();
  存();
}
console.log("done", path.join(输出, "result.json"));
