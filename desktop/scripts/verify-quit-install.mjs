#!/usr/bin/env node
/**
 * 真机验「差量自动下 + 退出时顺手换包」（0.37.4 的两条）。
 *
 * 单测盖得住 换包同步() 本身，盖不住的是它在 before-quit 里那一下：进程正在退、
 * Electron 的事件顺序、.app.new 是不是真拼好了。所以拿**打出来的包**跑一遍：
 *
 *   1. 把 .app 拷到一个可写的临时目录（不碰 /Applications 里用户正在用的那个）
 *   2. 本地起一个假 feed：版本写 9.9.9，zip / 清单指向某个老版本的真差量产物
 *   3. 用隔离的数据目录启动它（CRM_DATA_ROOT：独立数据、独立单实例锁）
 *   4. 等它自己把差量拼成 .app.new——不点任何按钮，这就是「自动下」
 *   5. 通过 CDP 正常关掉（Browser.close 走的是 app.quit → before-quit），不是 kill
 *   6. 核对：.app 的版本变成了老版本、.app.old 是刚才那个、日志里有「退出时换包」
 *
 * 用法：node desktop/scripts/verify-quit-install.mjs <Daedalus CRM.app> <目标版本> <zipUrl> <manifestUrl>
 * 例：  node desktop/scripts/verify-quit-install.mjs ~/tmp/Daedalus\ CRM.app 0.37.3 \
 *         https://github.com/…/Daedalus.CRM-0.37.3-arm64.app.zip https://github.com/…/Daedalus.CRM-0.37.3-arm64.manifest.json.gz
 */
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const [源app, 目标版本, zipUrl, manifestUrl] = process.argv.slice(2);
if (!源app || !目标版本 || !zipUrl || !manifestUrl) {
  console.error("用法：verify-quit-install.mjs <app> <目标版本> <zipUrl> <manifestUrl>");
  process.exit(2);
}
const 版本 = (app) => execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(app, "Contents/Info.plist")]).toString().trim();
const 等 = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. 拷到临时目录
const 沙盒 = fs.mkdtempSync(path.join(os.tmpdir(), "quit-install-"));
const app = path.join(沙盒, "Daedalus CRM.app");
execFileSync("ditto", [源app, app]);
const 数据根 = path.join(沙盒, "data");
fs.mkdirSync(数据根, { recursive: true });
console.log(`拷贝到 ${app}，装的是 ${版本(app)}`);

// 2. 假 feed
const feed = { version: "9.9.9", url: "https://example.invalid", dmg: "https://example.invalid/none.dmg", zip: zipUrl, manifest: manifestUrl, notes: "验证用", size: "0 MB" };
const 服务器 = http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(feed)); });
await new Promise((r) => 服务器.listen(0, "127.0.0.1", r));
const feedUrl = `http://127.0.0.1:${服务器.address().port}/latest.json`;

// 3. 起它
const 端口 = 9333;
const 进程 = spawn(path.join(app, "Contents/MacOS/Daedalus CRM"), [`--remote-debugging-port=${端口}`], {
  env: { ...process.env, CRM_UPDATE_URL: feedUrl, CRM_DATA_ROOT: 数据根, CRM_UPDATE_FALLBACK_URL: "http://127.0.0.1:9/none" },
  stdio: "ignore",
});
let 退出码 = null;
进程.on("exit", (c) => { 退出码 = c; });

// 4. 等 .app.new 拼好（启动 15 秒后才开始查，再加下载）
const 新包 = `${app}.new`;
const 开始 = Date.now();
while (!fs.existsSync(path.join(新包, "Contents/Info.plist"))) {
  if (退出码 !== null) { console.error(`应用自己退出了（${退出码}）`); process.exit(1); }
  if (Date.now() - 开始 > 5 * 60_000) { console.error("5 分钟内没拼出 .app.new"); 进程.kill(); process.exit(1); }
  await 等(2000);
}
// 拼好之后主进程还要验签、写 ready 状态，给它几秒
await 等(5000);
console.log(`.app.new 拼好了（${Math.round((Date.now() - 开始) / 1000)}s），里面是 ${版本(新包)}`);

// 5. 正常退出：走 CDP 的 Browser.close，Electron 会当成 app.quit()，before-quit 照常触发
const 列表 = await (await fetch(`http://127.0.0.1:${端口}/json/version`)).json();
const ws = new WebSocket(列表.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
const 退出开始 = Date.now();
while (退出码 === null) {
  if (Date.now() - 退出开始 > 30_000) { console.error("30 秒还没退出"); 进程.kill(); process.exit(1); }
  await 等(500);
}
服务器.close();

// 6. 核对
const 日志 = fs.readFileSync(path.join(数据根, "logs/app.log"), "utf8");
const 现在 = 版本(app);
const 旧 = fs.existsSync(`${app}.old`) ? 版本(`${app}.old`) : null;
console.log(`退出后：.app = ${现在}，.app.old = ${旧}`);
console.log(日志.split("\n").filter((l) => /退出时换包|差量/.test(l)).slice(-6).join("\n"));
const ok = 现在 === 目标版本 && 旧 !== null && /退出时换包/.test(日志) && !/退出时换包失败/.test(日志);
console.log(ok ? "✅ 退出时换包：通过" : "❌ 退出时换包：没通过");
fs.rmSync(沙盒, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
