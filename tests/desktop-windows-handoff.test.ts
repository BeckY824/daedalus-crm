import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require_ = createRequire(import.meta.url);
const 模块 = path.resolve(__dirname, "../desktop/windows-install.js");
const { 启动换目录, 安装进行中 } = require_(模块);
const 根们: string[] = [];
function 沙盒() {
  const 根 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-handoff-"));
  根们.push(根);
  return 根;
}
afterEach(() => {
  for (const 根 of 根们.splice(0)) fs.rmSync(根, { recursive: true, force: true });
});
const 等 = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function 假进程() {
  const child = Object.assign(new EventEmitter(), { unref() {} });
  let 交接 = "";
  return {
    child,
    路径: () => 交接,
    启动: (_exe: string, args: string[]) => {
      const 命令 = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
      交接 = 命令.match(/-Handshake '([^']+)'/)![1];
      return child;
    },
  };
}

describe("Windows 更新交接", () => {
  it.each(["ready-first", "exit-first"])("必须同时等到脚本就绪和中转退出：%s", async (顺序) => {
    const fake = 假进程();
    const 更新目录 = 沙盒();
    let 完成 = false;
    const result = 启动换目录({ 目录: "C:\\test\\app", 更新目录, 启动: fake.启动 }).then(() => { 完成 = true; });
    const ready = () => fs.writeFileSync(`${fake.路径()}.ready`, String(process.pid));
    const exit = () => fake.child.emit("exit", 0);
    (顺序 === "ready-first" ? ready : exit)();
    await 等(75);
    expect(完成).toBe(false);
    expect(fs.existsSync(`${fake.路径()}.go`)).toBe(false);
    (顺序 === "ready-first" ? exit : ready)();
    await result;
    expect(fs.existsSync(`${fake.路径()}.go`)).toBe(true);
    expect(安装进行中(更新目录)).toMatchObject({ pid: process.pid, 方式: "差量" });
  });

  it.each(["timeout", "spawn-error", "exit-error"])("%s 时取消，旧就绪日志不能授权迟到的脚本", async (失败) => {
    const fake = 假进程();
    const 更新目录 = 沙盒();
    fs.writeFileSync(path.join(更新目录, "update-swap.log"), "begin old attempt\nswapped");
    const result = 启动换目录({ 目录: "C:\\test\\app", 更新目录, 启动: fake.启动, 就绪超时: 80 });
    const assertion = expect(result).rejects.toThrow();
    if (失败 === "spawn-error") fake.child.emit("error", new Error("ENOENT"));
    else fake.child.emit("exit", 失败 === "exit-error" ? 1 : 0);
    await assertion;
    expect(fs.existsSync(`${fake.路径()}.cancel`)).toBe(true);
    expect(fs.existsSync(path.join(更新目录, "installing.json"))).toBe(false);
    fs.writeFileSync(`${fake.路径()}.ready`, String(process.pid));
    await 等(50);
    expect(fs.existsSync(`${fake.路径()}.go`)).toBe(false);
  });
});

const electronPath = (() => {
  try { return require_("../desktop/node_modules/electron") as string; } catch { return ""; }
})();
describe.skipIf(process.platform !== "win32" || !electronPath)("真实 Electron 退出交接", () => {
  it("超时后迟到的真实 PowerShell 不得更换旧目录", async () => {
    const 根 = 沙盒();
    const 目录 = path.join(根, "app");
    fs.mkdirSync(目录); fs.mkdirSync(`${目录}.new`);
    fs.writeFileSync(path.join(目录, "version.txt"), "old");
    fs.writeFileSync(path.join(`${目录}.new`, "version.txt"), "new");
    let args: string[] = [];
    await expect(启动换目录({
      目录, 更新目录: path.join(根, "updates"), 就绪超时: 50,
      启动: (_exe: string, 参数: string[]) => {
        args = 参数.slice(参数.indexOf("-NoProfile"));
        const child = Object.assign(new EventEmitter(), { unref() {} });
        queueMicrotask(() => child.emit("exit", 0));
        return child;
      },
    })).rejects.toThrow(/超时/);
    const child = spawn("powershell.exe", args, { windowsHide: true, stdio: "ignore" });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    expect(code).toBe(5);
    expect(fs.readFileSync(path.join(目录, "version.txt"), "utf8")).toBe("old");
    expect(fs.existsSync(`${目录}.new`)).toBe(true);
    expect(fs.existsSync(`${目录}.old`)).toBe(false);
  });

  it.each(["restart", "quit"])("%s：交接完成后立即退出仍能换目录", async (模式) => {
    const 根 = 沙盒();
    const 目录 = path.join(根, "Programs 中文", "O'Brien CRM");
    fs.mkdirSync(目录, { recursive: true });
    fs.mkdirSync(`${目录}.new`);
    fs.writeFileSync(path.join(目录, "version.txt"), "old");
    fs.writeFileSync(path.join(`${目录}.new`, "version.txt"), "new");
    const 更新目录 = path.join(根, "updates");
    const harness = path.join(根, "main.cjs");
    // 使用真实主进程里的 before-quit 处理器，依赖仅以无业务副作用的替身提供。
    const source = fs.readFileSync(path.resolve(__dirname, "../desktop/main.js"), "utf8");
    const handler = source.slice(source.indexOf('  app.on("before-quit",'), source.indexOf('  app.on("window-all-closed",'));
    const wrapperStart = source.indexOf("let 窗更新交接中 =");
    const wrapper = source.slice(wrapperStart, source.indexOf("\n/**", wrapperStart));
    const install = source.slice(source.indexOf("async function 安装更新()"), source.indexOf('ipcMain.handle("update:state"'));
    fs.writeFileSync(harness, `
      const {app}=require('electron'); const fs=require('node:fs'),path=require('node:path');
      app.setPath('userData',${JSON.stringify(path.join(根, "userData"))});
      const 窗装=require(${JSON.stringify(模块)}), 应用包=${JSON.stringify(目录)}, 更新目录=${JSON.stringify(更新目录)};
      let 待装={方式:'差量',版本:'99.0.0'}, 更新状态={阶段:'ready'};
      const 崩溃={写崩溃日志(){}}, 应用日志='', 提醒器=null, 本地服务={运行中:()=>false,stop(){}}, MCP桥={stop(){}};
      const 设更新状态=(s)=>{更新状态=s}, win={isDestroyed:()=>false}, 建窗口=()=>{}, 通知安装中=()=>{};
      const dialog={showMessageBox(){app.exit(2)}};
      ${wrapper}
      ${install}
      ${handler}
      app.whenReady().then(async()=>{
        if(${JSON.stringify(模式)}==='restart'){await 安装更新()}
        else {app.quit(); app.quit()}
      }).catch(e=>{fs.writeFileSync(${JSON.stringify(path.join(根, "error.txt"))},String(e));app.exit(3)});
    `);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, [harness], { env, windowsHide: true, stdio: "ignore" });
    let killTimer: ReturnType<typeof setTimeout>;
    const code = await new Promise((resolve, reject) => {
      killTimer = setTimeout(() => { child.kill(); reject(new Error("Electron handoff timeout")); }, 30_000);
      child.once("error", reject); child.once("exit", resolve);
    }).finally(() => clearTimeout(killTimer));
    expect(code).toBe(0);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && fs.existsSync(`${目录}.new`)) await 等(100);
    expect(fs.readFileSync(path.join(目录, "version.txt"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(`${目录}.old`, "version.txt"), "utf8")).toBe("old");
    expect(fs.readdirSync(更新目录).filter(n => n.startsWith("swap-") && n !== "swap-attempts.json")).toHaveLength(1);
    // 等脚本释放文件句柄，再回收临时目录。
    await 等(500);
  }, 45_000);
});
