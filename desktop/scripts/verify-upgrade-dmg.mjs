#!/usr/bin/env node
/**
 * 真机验「整包更新」：已装的旧版下载新 dmg → 核 sha256 → 挂载、验签、复制、换包 → 重启（2026-10-20，优化 #1 / #4）。
 *
 * verify-quit-install.mjs 验的是差量那条路，dmg 在那里只是占位。这一份专门走整包：
 * 包变小、dmg 换成 ULMO 以后，**旧版里的 install.js**（hdiutil attach → codesign → ditto → 换包）还得认得新 dmg。
 *
 *   1. 把旧版 .app 拷到临时目录（不碰 /Applications 里那个）
 *   2. 本地起假 feed：版本 9.9.9，只给 dmg 和它真实的 sha256，不给 zip / 清单，强制走整包
 *   3. 用隔离的数据目录起旧版，像用户那样：检查更新 → 点下载 → 点安装（走 window.desktopUpdate，和左栏按钮同一条 IPC）
 *   4. 核对：原位上的 .app 和 dmg 里的一模一样（签名清单 CodeResources + app.asar）、整包签名校验过、自动重启起来了
 *      只改打包方式的分支（比如 #4 换 dmg 格式）app.asar 和旧版逐字节相同，所以拿签名清单判定「换成了 dmg 里那个」
 *
 * 用法：node desktop/scripts/verify-upgrade-dmg.mjs <旧版 Daedalus CRM.app> <新 dmg>
 * 例：  node desktop/scripts/verify-upgrade-dmg.mjs "/Applications/Daedalus CRM.app" "desktop/dist/Daedalus CRM-0.46.22-arm64.dmg"
 */
import { _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const [源app, dmg] = process.argv.slice(2);
if (!源app || !dmg || !fs.existsSync(源app) || !fs.existsSync(dmg)) {
  console.error("用法：verify-upgrade-dmg.mjs <旧版 .app> <新 dmg>");
  process.exit(2);
}
const 版本 = (app) => execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(app, "Contents/Info.plist")]).toString().trim();
const 哈希 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const 语言包 = (app) => fs.readdirSync(path.join(app, "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources")).filter((n) => n.endsWith(".lproj")).length;
const 等 = (ms) => new Promise((r) => setTimeout(r, ms));
async function 等到(fn, ms, 什么) {
  const 止 = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > 止) throw new Error(`等了 ${ms / 1000}s 还没${什么}`);
    await 等(1000);
  }
}

// dmg 里那个 .app 的指纹：换完以后原位上的必须是它。签名清单列了包里每个文件的哈希，ad-hoc 签名每次打包都不同
const 挂载 = fs.mkdtempSync(path.join(os.tmpdir(), "verify-dmg-mnt-"));
execFileSync("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", 挂载]);
const 指纹 = (app) => 哈希(path.join(app, "Contents/_CodeSignature/CodeResources")) + 哈希(path.join(app, "Contents/Resources/app.asar"));
let 新指纹, 新asar;
try {
  const 包 = fs.readdirSync(挂载).find((n) => n.endsWith(".app"));
  新指纹 = 指纹(path.join(挂载, 包));
  新asar = 哈希(path.join(挂载, 包, "Contents/Resources/app.asar"));
} finally {
  execFileSync("hdiutil", ["detach", 挂载, "-force"]);
}
const 格式 = /^Format: (\S+)/m.exec(execFileSync("hdiutil", ["imageinfo", dmg], { encoding: "utf8" }))?.[1];
console.log(`新 dmg：${(fs.statSync(dmg).size / 1048576).toFixed(1)} MB，格式 ${格式}`);

// 1. 拷到临时目录
const 沙盒 = fs.mkdtempSync(path.join(os.tmpdir(), "verify-dmg-"));
const app = path.join(沙盒, "Daedalus CRM.app");
execFileSync("ditto", [源app, app]);
const 数据根 = path.join(沙盒, "data");
fs.mkdirSync(数据根, { recursive: true });
const 旧指纹 = 指纹(app);
const 旧asar = 哈希(path.join(app, "Contents/Resources/app.asar"));
console.log(`旧版拷到 ${app}：${版本(app)}，语言包 ${语言包(app)} 个`);

// 2. 假 feed + dmg（带 Range，install.js 断了会续传）
const dmg哈希 = 哈希(dmg);
let dmg请求 = 0;
const 服务器 = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/latest.json") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ version: "9.9.9", url: "https://example.invalid", dmg: `${基址}/new.dmg`, sha256: dmg哈希, notes: "验证用", size: `${Math.round(fs.statSync(dmg).size / 1048576)} MB` }));
  }
  if (url === "/new.dmg") {
    dmg请求++;
    const 大小 = fs.statSync(dmg).size;
    const m = /^bytes=(\d+)-$/.exec(req.headers.range || "");
    const 起 = m ? Number(m[1]) : 0;
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("content-length", 大小 - 起);
    if (m) { res.statusCode = 206; res.setHeader("content-range", `bytes ${起}-${大小 - 1}/${大小}`); }
    return fs.createReadStream(dmg, { start: 起 }).pipe(res);
  }
  res.setHeader("content-type", "application/json");
  res.statusCode = 404;
  res.end("{}");
});
await new Promise((r) => 服务器.listen(0, "127.0.0.1", r));
const 基址 = `http://127.0.0.1:${服务器.address().port}`;

// 3. 起旧版，像用户那样点
const env = { ...process.env, CRM_DATA_ROOT: 数据根, CRM_CLOUD_URL: 基址, CRM_UPDATE_URL: `${基址}/latest.json`, CRM_UPDATE_FALLBACK_URL: `${基址}/none`, CRM_UPDATE_ALLOW_LOCAL_HTTP: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const 应用 = await electron.launch({ executablePath: path.join(app, "Contents/MacOS/Daedalus CRM"), env, timeout: 60_000 });
const 进程 = 应用.process();
const 退了 = new Promise((r) => (进程.exitCode !== null ? r() : 进程.once("exit", r)));
let ok = false;
try {
  const 页 = await 应用.firstWindow();
  await 等到(() => 页.evaluate(() => typeof window.desktopUpdate?.check === "function").catch(() => false), 60_000, "拿到 desktopUpdate");
  await 页.evaluate(() => window.desktopUpdate.check(true));
  let 态 = await 等到(async () => { const s = await 页.evaluate(() => window.desktopUpdate.state()); return s.阶段 === "available" && s; }, 60_000, "查到新版");
  if (!/整包/.test(态.文字)) throw new Error(`应该走整包，实际：${态.文字}`);
  console.log(`查到 ${态.版本}：${态.文字}`);
  await 页.evaluate(() => window.desktopUpdate.download());
  态 = await 等到(async () => { const s = await 页.evaluate(() => window.desktopUpdate.state()); return ["ready", "error"].includes(s.阶段) && s; }, 5 * 60_000, "下完");
  if (态.阶段 !== "ready") throw new Error(`下载没成：${JSON.stringify(态)}`);
  console.log(`下完、sha256 核过（dmg 请求 ${dmg请求} 次）`);
  await 页.evaluate(() => window.desktopUpdate.install()).catch(() => {});
  await Promise.race([退了, 等(60_000).then(() => { throw new Error("点了安装 60 秒还没退"); })]);

  // 4. 换包在退出前做完；随后自动重启的是新版，它一起来就把 .app.old 清掉（清理旧包），所以不拿 .old 当证据，
  //    看原位上的 .app 变成了 dmg 里那个、再看重启起来的进程
  if (新指纹 === 旧指纹) throw new Error("dmg 里的 .app 和旧版指纹一样，分不出换没换");
  await 等到(() => { try { return 指纹(app) === 新指纹; } catch { return false; } }, 60_000, "换成新包");
  const 重启了 = await 等到(() => { try { execFileSync("pgrep", ["-f", path.join(app, "Contents/MacOS")]); return true; } catch { return false; } }, 60_000, "自动重启").catch(() => false);
  await 等(8000);
  try { execFileSync("pkill", ["-f", 沙盒]); } catch { /* 已经退了 */ }
  execFileSync("codesign", ["--verify", "--strict", "--deep", app]);
  console.log(`换完：.app = ${版本(app)}，语言包 ${语言包(app)} 个，app.asar ${新asar === 旧asar ? "和旧版相同（只改了打包）" : "已换新"}，整包签名校验通过；自动重启：${重启了 ? "起来了" : "没看到"}`);
  ok = 指纹(app) === 新指纹 && 重启了 && dmg请求 > 0;
} catch (e) {
  console.error(e);
  const 日志文件 = path.join(数据根, "logs/app.log");
  if (fs.existsSync(日志文件)) console.error(fs.readFileSync(日志文件, "utf8").slice(-4000));
} finally {
  await 应用.close().catch(() => {});
  try { execFileSync("pkill", ["-f", 沙盒]); } catch { /* 已经退了 */ }
  服务器.close();
}
console.log(ok ? "✅ 整包更新（dmg）：通过" : "❌ 整包更新（dmg）：没通过");
if (ok) fs.rmSync(沙盒, { recursive: true, force: true });
else console.log(`现场留在 ${沙盒}`);
process.exit(ok ? 0 : 1);
