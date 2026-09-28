/**
 * Windows 差量更新的真机冒烟（CI 的 Windows job 跑，打包之后）：
 *
 *   1. 用刚打出来的安装程序静默装到一个带中文和空格的目录（和真用户一样：NSIS 装的、带卸载程序、写了注册表）
 *   2. 把装好的目录弄「旧」一点：改一个文件、删一个、多一个旧版留下的；「应用和功能」里的版本号改成 0.0.1
 *   3. 本机起一个假的更新源：feed 说有 99.0.0，zip 和清单就是这次 CI 打的（只认 Range）
 *   4. 从安装目录启动应用，**走应用自己的检查更新**：应该估出差量、自己下好（阶段 ready、文字写着差量）
 *   5. 关掉应用 → before-quit 把换目录交给 PowerShell → 等它换完
 *   6. 验：每个文件和清单一致、卸载程序还在、旧版留下的没了、版本号成了 99.0.0；
 *      再开一次，启动时把 .old 清掉
 *
 *   7. 拿换过的那个 exe 把 smoke-windows.mjs 整套再跑一遍（登录、建客户、备份、切账号…）：换出来的目录不光文件对，还真能用
 *
 * 用法： node scripts/smoke-windows-delta.mjs   （在 desktop/ 下，dist 里要有 setup.exe、-win.zip、-win.manifest.json.gz）
 * 第 7 步由这里直接起 node 子进程传路径——不经 bash，中文路径不会被 msys 转坏。
 */
import { _electron as electron } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(desktop, "dist");
const 找 = (re) => {
  const n = fs.readdirSync(dist).find((x) => re.test(x));
  if (!n) throw new Error(`dist 里没有 ${re}`);
  return path.join(dist, n);
};
const setup = 找(/-x64-setup\.exe$/);
const zip = 找(/-x64-win\.zip$/);
const 清单文件 = 找(/-x64-win\.manifest\.json\.gz$/);
const 清单 = JSON.parse(zlib.gunzipSync(fs.readFileSync(清单文件)).toString("utf8"));
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const 等 = async (条件, 毫秒, 说明) => {
  const 止 = Date.now() + 毫秒;
  while (Date.now() < 止) {
    const v = await 条件();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`等不到：${说明}`);
};

// 长路径：tmpdir 在 runner 上是 RUNNER~1 这种 8.3 短名，真用户的快捷方式指向的是长路径
const 根 = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "差量 冒烟-"));
/**
 * 装到默认位置（只为我安装：%LOCALAPPDATA%\Programs\daedalus-crm）——真用户装到的就是这儿。
 * 原来用 /D= 指到临时目录下一条「Programs 中文」长路径：CI 上两次都坏在这一步
 * （一次退出码 0 却没装到那儿，一次 NSIS 直接崩 0xC0000005）。中文 + 单引号路径的换目录
 * 由 tests/desktop-windows-delta.test.ts 在真 PowerShell 上覆盖。实际装在哪以注册表卸载项为准，见第 1 步
 */
let 装到 = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "daedalus-crm");
const 数据 = path.join(根, "data");
fs.mkdirSync(数据, { recursive: true });

function 显示版本() {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$d = $env:CRM_DIR.ToLowerInvariant() + '\\uninstall '; Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | ForEach-Object { $p = Get-ItemProperty -LiteralPath $_.PSPath; if ($p.UninstallString -and $p.UninstallString.ToLowerInvariant().Contains($d)) { $p.DisplayVersion } }",
  ], { encoding: "utf8", env: { ...process.env, CRM_DIR: 装到 } });
  return r.stdout.trim();
}

// 1) 静默装。/D= 必须是最后一个、不能带引号（哪怕有空格）——所以参数原样传，不让 node 加引号
{
  const r = spawnSync(setup, ["/S", "/currentuser"], { timeout: 300_000 });
  if (r.status !== 0) throw new Error(`安装程序退出码 ${r.status}`);
  /*
    2026-09-29 第一次在 CI 上跑：安装程序退出码 0，60 秒后 /D= 指的地方还是没有 exe——electron-builder 的
    多用户逻辑见到 /currentuser 可能把目录改回默认的 %LOCALAPPDATA%\Programs\daedalus-crm。
    所以装在哪儿**以注册表里的卸载项为准**，和 /D= 不一样就照实说一句、后面都用实际那个目录
    （那也正是真用户默认会装到的地方）
  */
  const 实际 = await 等(() => {
    if (fs.existsSync(path.join(装到, "Daedalus CRM.exe"))) return 装到;
    const q = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | ForEach-Object { $p = Get-ItemProperty -LiteralPath $_.PSPath; if ($p.DisplayName -like 'Daedalus CRM*' -and $p.UninstallString) { $p.UninstallString } }",
    ], { encoding: "utf8" });
    const m = /"?([^"]+)\\Uninstall [^"\\]+\.exe"?/i.exec(q.stdout || "");
    return m && fs.existsSync(path.join(m[1], "Daedalus CRM.exe")) ? m[1] : null;
  }, 90_000, "安装完成（默认位置和注册表卸载项里都找不到 Daedalus CRM.exe）");
  if (path.resolve(实际).toLowerCase() !== path.resolve(装到).toLowerCase()) {
    console.log(`注意：实际装在 ${实际}，不是默认位置（后面都用这个目录）`);
    装到 = 实际;
  }
  if (!fs.readdirSync(装到).some((n) => /^Uninstall .+\.exe$/i.test(n))) throw new Error("装好的目录里没有卸载程序");
  console.log(`PASS: NSIS 静默装到 ${装到}，注册表版本 ${显示版本()}`);
}

// 2) 弄旧：改一个、删一个、多一个；注册表版本改成 0.0.1
const 大文件 = 清单.entries.filter((e) => e.t === "f" && /\.(html|pak)$/.test(e.p)).sort((a, b) => b.s - a.s);
const 改的 = 大文件.find((e) => /LICENSES|license/i.test(e.p)) ?? 大文件[0];
const 删的 = 大文件.find((e) => /^locales\//.test(e.p) && e.p !== 改的.p && !/en-US|zh-CN/.test(e.p));
fs.appendFileSync(path.join(装到, 改的.p), "\n<!-- 旧版 -->");
fs.rmSync(path.join(装到, 删的.p));
fs.writeFileSync(path.join(装到, "resources", "旧版留下的.txt"), "stale");
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  "$d = $env:CRM_DIR.ToLowerInvariant() + '\\uninstall '; Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | ForEach-Object { $p = Get-ItemProperty -LiteralPath $_.PSPath; if ($p.UninstallString -and $p.UninstallString.ToLowerInvariant().Contains($d)) { Set-ItemProperty -LiteralPath $_.PSPath -Name DisplayVersion -Value '0.0.1' } }",
], { env: { ...process.env, CRM_DIR: 装到 } });
if (显示版本() !== "0.0.1") throw new Error("改不了注册表里的版本号，后面验不出来");
console.log(`PASS: 弄旧——改了 ${改的.p}、删了 ${删的.p}、多了 resources\\旧版留下的.txt`);

// 3) 假更新源
const 统计 = { range: 0, 字节: 0, 整包: 0 };
const server = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  if (u === "/updates") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      version: "99.0.0",
      platforms: { "win32-x64": { version: "99.0.0", notes: "冒烟", exe: `${base}/setup.exe`, sha256: sha(setup), size: "1 MB", zip: `${base}/win.zip`, manifest: `${base}/win.manifest`, manifest_sha256: sha(清单文件) } },
    }));
  }
  if (u === "/win.manifest") return fs.createReadStream(清单文件).pipe(res);
  if (u === "/win.zip") {
    const size = fs.statSync(zip).size;
    if (req.method === "HEAD") return res.writeHead(200, { "Content-Length": size }).end();
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
    if (!m) { 统计.整包++; res.writeHead(200, { "Content-Length": size }); return fs.createReadStream(zip).pipe(res); }
    const [s, e] = [Number(m[1]), Number(m[2])];
    统计.range++; 统计.字节 += e - s + 1;
    res.writeHead(206, { "Content-Range": `bytes ${s}-${e}/${size}`, "Content-Length": e - s + 1 });
    return fs.createReadStream(zip, { start: s, end: e }).pipe(res);
  }
  if (u === "/setup.exe") { 统计.整包++; res.statusCode = 404; return res.end(); }
  // GitHub 兜底源和云端接口：一律「没有」，更新只听上面那份 feed
  res.setHeader("Content-Type", "application/json");
  res.statusCode = 404;
  res.end("{}");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, CRM_DATA_ROOT: 数据, CRM_CLOUD_URL: base, CRM_UPDATE_URL: `${base}/updates`, CRM_UPDATE_FALLBACK_URL: `${base}/gh` };
delete env.ELECTRON_RUN_AS_NODE;
const exe = path.join(装到, "Daedalus CRM.exe");
const 日志尾 = () => {
  for (const f of [path.join(数据, "logs", "app.log"), path.join(数据, "updates", "update-swap.log"), path.join(数据, "updates", "update-swap.out.log")]) {
    if (fs.existsSync(f)) console.error(`--- ${f}\n${fs.readFileSync(f, "utf8").slice(-4000)}`);
  }
};

let app;
try {
  // 4) 走应用自己的检查更新（启动 15 秒后那一次）
  app = await electron.launch({ executablePath: exe, env, timeout: 60_000 });
  const page = await app.firstWindow();
  const 状态 = await 等(async () => {
    const s = await page.evaluate(() => window.desktopUpdate?.state()).catch(() => null);
    if (s?.阶段 === "error") throw new Error(`更新出错：${JSON.stringify(s)}`);
    if (s?.阶段 === "available" && !String(s.文字 || "").includes("差量")) throw new Error(`没走差量：${JSON.stringify(s)}`);
    return s?.阶段 === "ready" ? s : null;
  }, 120_000, "差量下好（阶段 ready）");
  console.log(`PASS: 应用自己估出差量并下好：${状态.文字}（Range ${统计.range} 次、${(统计.字节 / 1048576).toFixed(2)} MB，整包请求 ${统计.整包}）`);
  if (统计.整包) throw new Error("有整包请求：差量没兜住");
  if (!fs.existsSync(`${装到}.new`)) throw new Error("阶段 ready 了却没有 .new");

  /*
    5) 关掉 → before-quit 交给 PowerShell 换目录。
    **像人一样退出（app.quit），不用 Playwright 的 app.close()**：它在 Windows 上收尾时 taskkill /T /F 整棵进程树，
    我们刚起的那个 PowerShell（父进程是 Electron）一起被杀，一行日志都来不及写（2026-09-29 CI 上第三次就栽在这）。
    真用户退出时没人杀进程树
  */
  const 进程 = app.process();
  const 退了 = new Promise((r) => (进程.exitCode !== null ? r() : 进程.once("exit", r)));
  await app.evaluate(({ app: a }) => a.quit()).catch(() => {});
  await Promise.race([退了, new Promise((r) => setTimeout(r, 30_000))]);
  app = null;
  await 等(() => fs.existsSync(`${装到}.old`) && !fs.existsSync(`${装到}.new`) && fs.existsSync(exe), 120_000, "换目录完成");
  console.log("PASS: 退出后换目录完成（旧的成了 .old）");

  // 6) 验
  const 错 = [];
  for (const e of 清单.entries) {
    if (e.t !== "f") continue;
    const p = path.join(装到, e.p);
    if (!fs.existsSync(p)) 错.push(`缺 ${e.p}`);
    else if (sha(p) !== e.h) 错.push(`不一致 ${e.p}`);
  }
  if (错.length) throw new Error(`换完的目录和清单对不上：\n${错.slice(0, 20).join("\n")}`);
  if (!fs.readdirSync(装到).some((n) => /^Uninstall .+\.exe$/i.test(n))) throw new Error("卸载程序没了");
  if (fs.existsSync(path.join(装到, "resources", "旧版留下的.txt"))) throw new Error("旧版留下的文件还在");
  const v = 显示版本();
  if (v !== "99.0.0") throw new Error(`「应用和功能」里的版本号是 ${v}，不是 99.0.0`);
  console.log(`PASS: ${清单.entries.length} 个文件和清单一致、卸载程序在、旧文件清掉、注册表版本 ${v}`);

  // 再开一次：能起来，启动时把 .old 清掉
  app = await electron.launch({ executablePath: exe, env, timeout: 60_000 });
  await app.firstWindow();
  await 等(() => !fs.existsSync(`${装到}.old`), 60_000, "启动时清掉 .old");
  await app.close();
  app = null;
  console.log("PASS: 新目录起得来，.old 已清掉");

  // 7) 换出来的目录整套功能再跑一遍
  execFileSync(process.execPath, [path.join(desktop, "scripts", "smoke-windows.mjs"), exe], { stdio: "inherit", cwd: desktop });
  console.log("PASS: 换过的目录跑完整套 Windows 冒烟");
} catch (e) {
  日志尾();
  throw e;
} finally {
  if (app) await app.close().catch(() => {});
  server.close();
}
