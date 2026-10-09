/** Actual NSIS full update. Synthetic feed version 99 only triggers the check;
 * the installer and restarted application must retain their real 0.46.16 version.
 * No Windows delta archive or manifest is generated or requested.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect } from "@playwright/test";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(desktop, "dist");
const setupName = fs.readdirSync(dist).find(n => /-x64-setup\.exe$/.test(n));
assert(setupName, "missing NSIS installer");
const setup = path.join(dist, setupName);
const version = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"))).version;
const sha = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const installerHash = sha(setup);
// Assisted NSIS uses productFilename (including the space), not package name.
const installed = path.join(process.env.LOCALAPPDATA, "Programs", "Daedalus CRM");
const exe = path.join(installed, "Daedalus CRM.exe");
const wait = async (fn, ms, reason) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error("Timed out: " + reason);
};
function businessSmoke() {
  const r = spawnSync(process.execPath, [path.join(desktop, "scripts", "smoke-windows.mjs"), exe], {
    cwd: desktop, encoding: "utf8", timeout: 420_000, maxBuffer: 10 * 1024 * 1024,
  });
  process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
  assert.equal(r.status, 0, "installed package business smoke failed");
  const root = [...r.stdout.matchAll(/^Evidence: (.+)$/gm)].at(-1)?.[1]?.trim();
  assert(root && fs.existsSync(root), "missing isolated smoke data root");
  return root;
}
const initial = spawnSync(setup, ["/S", "/currentuser"], { timeout: 300_000 });
if (initial.status !== 0) {
  const diagnostic = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-WinEvent -FilterHashtable @{LogName='Application';Id=1000,1001;StartTime=(Get-Date).AddMinutes(-5)} -ErrorAction SilentlyContinue | Where-Object { $_.Message -like '*Daedalus*' } | Select-Object TimeCreated,Id,Message | Format-List | Out-String -Width 300"],
  { encoding: "utf8", timeout: 15_000 });
  console.error(diagnostic.stdout || "No installer crash event available yet");
  console.error(JSON.stringify({ installerExit: initial.status, error: initial.error?.message }));
}
assert.equal(initial.status, 0, "initial NSIS install failed");
assert(fs.existsSync(exe), "NSIS did not install at the expected current-user path");
assert(fs.readdirSync(installed).some(n => /^Uninstall .+\.exe$/i.test(n)));
console.log("PASS: real NSIS current-user install and uninstaller");
const runtime = fs.readFileSync(exe);
const peOffset = runtime.readUInt32LE(0x3c);
assert.equal(runtime.subarray(peOffset, peOffset + 4).toString("hex"), "50450000");
assert.equal(runtime.readUInt16LE(peOffset + 4), 0x8664, "installed runtime must be Windows x64");
const asar = createRequire(import.meta.url)("@electron/asar");
const embedded = ["main.js","preload.js","preload-app.js","local-server.js","mcp-bridge.js","cloud.js","glass-blur.js","accounts.js","machine.js","updater.js","update-security.js","route-memory.js","install.js","windows-install.js","delta.js","backup.js","auto-backup.js","crashlog.js","reminders.js","sync.js","ops-notices.js","sign.js"].map(name => {
  const actual = asar.extractFile(path.join(installed, "resources", "app.asar"), name);
  const normalized = actual.toString("utf8").replaceAll("\r\n", "\n");
  assert.equal(normalized, fs.readFileSync(path.join(desktop, name), "utf8").replaceAll("\r\n", "\n"), "installed source mismatch: " + name);
  return { file: name, sha256: crypto.createHash("sha256").update(actual).digest("hex"),
    normalizedSha256: crypto.createHash("sha256").update(normalized).digest("hex") };
});
fs.writeFileSync(path.join(dist, `Daedalus-CRM-${version}-x64-verify.json`), JSON.stringify({
  source: process.env.GITHUB_SHA, version, platform: "win32-x64", peMachine: "AMD64 0x8664",
  installer: { file: setupName, bytes: fs.statSync(setup).size, sha256: installerHash },
  actualNsisInstalledSourceMatches: true, lineEndingNormalizationOnly: true, files: embedded,
}, null, 2) + "\n");
console.log("PASS: actual NSIS-installed Windows x64 runtime and all 22 embedded source files match checkout");
const root = businessSmoke();
const accounts = path.join(root, "accounts");
function snapshot() {
  return fs.readdirSync(accounts).sort().flatMap(key => {
    const file = path.join(accounts, key, "crm.db");
    if (!fs.existsSync(file)) return [];
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      return [{ key, customers: db.prepare("SELECT id,name,followStatus FROM Customer ORDER BY id").all(),
        orders: db.prepare("SELECT id,no FROM TradeOrder ORDER BY id").all(),
        marker: db.prepare("SELECT value FROM Setting WHERE key='smoke.marker'").get() ?? null }];
    } finally { db.close(); }
  });
}
const before = snapshot();
assert(before.some(a => a.customers.length && a.orders.length && a.marker?.value === "account A"));
// This non-executable installed file must really be replaced by NSIS.
const license = path.join(installed, "LICENSE.electron.txt");
assert(fs.existsSync(license)); const licenseHash = sha(license);
fs.appendFileSync(license, "\nQA FULL INSTALL REPLACEMENT MARKER\n");
assert.notEqual(sha(license), licenseHash);
const beforeAsar = sha(path.join(installed, "resources", "app.asar"));
let badHash = true;
const requests = { installer: 0, delta: 0 };
let base;
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  res.setHeader("content-type", "application/json");
  if (url === "/updates") return res.end(JSON.stringify({ platforms: { "win32-x64": {
    version: "99.0.0", exe: base + "/setup.exe", sha256: badHash ? "0".repeat(64) : installerHash,
    size: String(fs.statSync(setup).size) + " bytes",
    // Deliberately wrong extra fields must never cause Windows delta requests.
    zip: base + "/forbidden.zip", manifest: base + "/forbidden.manifest", manifest_sha256: "f".repeat(64),
  } } }));
  if (url === "/api/gateway/v1/credits") {
    const id = String(req.headers.authorization || "").replace("Bearer smoke-device-", "");
    return res.end(JSON.stringify({ accountId: id, 还剩: 30 }));
  }
  if (url === "/api/gateway/v1/models") return res.end('{"data":[]}');
  if (url.startsWith("/forbidden")) requests.delta++;
  if (url === "/setup.exe") {
    requests.installer++;
    const size = fs.statSync(setup).size;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range || "");
    const start = range ? Number(range[1]) : 0;
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("content-length", size - start);
    if (range) { res.statusCode = 206; res.setHeader("content-range", `bytes ${start}-${size - 1}/${size}`); }
    fs.createReadStream(setup, { start }).pipe(res); return;
  }
  res.statusCode = 404; res.end("{}");
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
base = `http://127.0.0.1:${server.address().port}`;
for (const key of fs.readdirSync(accounts)) {
  const file = path.join(accounts, key, ".cloud.json");
  if (fs.existsSync(file)) { const data = JSON.parse(fs.readFileSync(file)); data.baseUrl = base; fs.writeFileSync(file, JSON.stringify(data)); }
}
const env = { ...process.env, CRM_DATA_ROOT: root, CRM_CLOUD_URL: base,
  CRM_UPDATE_URL: base + "/updates", CRM_UPDATE_FALLBACK_URL: base + "/missing",
  CRM_UPDATE_ALLOW_LOCAL_HTTP: "1" };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ executablePath: exe, env, timeout: 60_000 });
  let page = await app.firstWindow();
  await expect(page.locator(".rail")).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => window.desktopUpdate.check(true));
  let state = await page.evaluate(() => window.desktopUpdate.state());
  assert.equal(state.阶段, "available"); assert.match(state.文字, /整包/);
  await page.evaluate(() => window.desktopUpdate.download());
  state = await page.evaluate(() => window.desktopUpdate.state());
  assert.equal(state.阶段, "error");
  assert.match(state.错误, /SHA|哈希|校验/i);
  assert.equal(sha(path.join(installed, "resources", "app.asar")), beforeAsar);
  assert.deepEqual(snapshot(), before);
  assert.equal(requests.delta, 0);
  console.log("PASS: actual full download rejects bad hash, program and both account databases unchanged");
  badHash = false;
  await page.evaluate(() => window.desktopUpdate.check(true));
  await page.evaluate(() => window.desktopUpdate.download());
  state = await page.evaluate(() => window.desktopUpdate.state());
  assert.equal(state.阶段, "ready"); assert.equal(state.版本, "99.0.0");
  assert.equal(requests.delta, 0); assert(requests.installer >= 2);
  assert(!fs.existsSync(installed + ".new"), "Windows must not assemble a delta directory");
  console.log("PASS: actual main process downloads verified full exe; zero delta requests");
  const serverLog = path.join(root, "logs", "server.log");
  const starts = () => (fs.readFileSync(serverLog, "utf8").match(/启动 =====/g) || []).length;
  const initialStarts = starts();
  const child = app.process();
  const exited = new Promise(r => child.exitCode !== null ? r(true) : child.once("exit", () => r(true)));
  await page.evaluate(() => window.desktopUpdate.install()).catch(() => {});
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("old app did not quit for NSIS")), 30_000))]);
  app = null;
  await wait(() => fs.existsSync(license) && sha(license) === licenseHash && starts() > initialStarts,
    180_000, "real NSIS replaces file and force-runs installed application");
  console.log("PASS: actual full NSIS installer replaces installed file and relaunches the app");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$p = [IO.Path]::GetFullPath($env:CRM_SMOKE_EXE); Get-Process | Where-Object { $_.Path -eq $p -and $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow(); [void]$_.WaitForExit(30000) }"],
    { env: { ...process.env, CRM_SMOKE_EXE: exe }, timeout: 45_000, stdio: "pipe" });
  app = await electron.launch({ executablePath: exe, env, timeout: 60_000 });
  page = await app.firstWindow(); await expect(page.locator(".rail")).toBeVisible({ timeout: 60_000 });
  assert.equal(await page.evaluate(() => window.desktopShell.version()), version);
  assert.deepEqual(snapshot(), before);
  const current = JSON.parse(fs.readFileSync(path.join(root, "current.json"))).key;
  const customer = before.find(a => a.key === current).customers.find(c => c.name === "Windows 外贸客户");
  assert(customer);
  await page.goto(new URL(page.url()).origin + "/customers/" + customer.id);
  await expect(page.getByRole("heading", { name: customer.name, exact: true })).toBeVisible();
  assert(!fs.existsSync(path.join(root, "updates", "installing.json")));
  assert(fs.readdirSync(installed).some(n => /^Uninstall .+\.exe$/i.test(n)));
  console.log("PASS: actual version, saved customer/order IDs, two accounts, marker, integrity and UI retained after full update");
  await app.close(); app = null;
  businessSmoke();
  console.log("PASS: full installed package passes the complete business smoke again");
} catch (error) {
  console.error("Evidence: " + root);
  if (app) for (const [i, page] of app.windows().entries()) {
    await page.screenshot({ path: path.join(root, `failure-full-update-${i}.png`) }).catch(() => {});
  }
  const log = path.join(root, "logs", "app.log");
  if (fs.existsSync(log)) console.error(fs.readFileSync(log, "utf8").slice(-6000));
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
  server.close();
}
