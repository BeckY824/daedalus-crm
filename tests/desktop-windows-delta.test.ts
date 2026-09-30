/**
 * Windows 差量更新（2026-09-28 起）：desktop/windows-install.js + delta.js 的 win32 分支 +
 * scripts/make-win-delta.mjs。
 *
 * 三组：
 *   - 纯逻辑，哪都跑：认不认安装目录、能不能差量、换目录脚本只许 ASCII、起脚本的参数、更新器挑资产
 *   - 整条链，哪都跑（7za 随 electron-builder 的 7zip-bin 带着三个平台的二进制）：
 *     用 CI 那个脚本把「新版 win-unpacked」打成 zip + 清单，以「旧安装目录」为基准按 Windows 规则组装，
 *     出来的 .new 必须和新版逐字节一致、卸载程序拷过去了、文件都可写（照 zip 里的 mode 0 写会全成只读）
 *   - 真的 PowerShell 换目录，只在 Windows 跑（CI 的 Windows job 跑全量 vitest）：
 *     等进程退出后换、目录被占着就放弃并保留旧版、没有 .new 不动、「应用和功能」的版本号跟着改
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const require_ = createRequire(import.meta.url);
const 窗装 = require_("../desktop/windows-install.js");
const 差量 = require_("../desktop/delta.js");
const { 检查 } = require_("../desktop/updater.js");
const 打包脚本 = path.resolve(__dirname, "../desktop/scripts/make-win-delta.mjs");
// 打包脚本要 7zip-bin（electron-builder 带进 desktop/node_modules 的）。主 CI 的单测 job 不装桌面端依赖，
// 那里找不到就跳过「整条链」；Desktop apps 的 Windows job 装了桌面端依赖、也跑全量单测，这条在那儿照跑。
// 2026-09-29 0.46.11 的主 CI 因此红过一次。
const 有7zip = (() => {
  try {
    createRequire(打包脚本).resolve("7zip-bin");
    return true;
  } catch {
    return false;
  }
})();
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

describe("认安装目录", () => {
  const 列 = (名们: string[]) => () => 名们;
  it("目录里有 NSIS 的卸载程序才算安装目录", () => {
    const exe = "C:\\Users\\张三\\AppData\\Local\\Programs\\daedalus-crm\\Daedalus CRM.exe";
    expect(窗装.安装目录(exe, { 列目录: 列(["Daedalus CRM.exe", "Uninstall Daedalus CRM.exe", "resources"]) })).toBe(
      "C:\\Users\\张三\\AppData\\Local\\Programs\\daedalus-crm",
    );
    // 解压版 / 开发态：没有卸载程序，不归差量换
    expect(窗装.安装目录(exe, { 列目录: 列(["Daedalus CRM.exe", "resources"]) })).toBeNull();
  });
  it("装在盘符根上、目录读不了：都不算", () => {
    expect(窗装.安装目录("D:\\Daedalus CRM.exe", { 列目录: 列(["Uninstall Daedalus CRM.exe"]) })).toBeNull();
    expect(窗装.安装目录("C:\\x\\a.exe", { 列目录: () => { throw new Error("EACCES"); } })).toBeNull();
    expect(窗装.安装目录("", {})).toBeNull();
  });
  it("父目录写不了（给所有用户装在 Program Files）就走整包，并说清原因", () => {
    expect(窗装.能差量更新(null).ok).toBe(false);
    const r = 窗装.能差量更新("C:\\Program Files\\Daedalus CRM", { 能写: (d: string) => d !== "C:\\Program Files" });
    expect(r).toMatchObject({ ok: false });
    expect(r.原因).toMatch(/Program Files/);
    expect(窗装.能差量更新("C:\\u\\Programs\\daedalus-crm", { 能写: () => true })).toEqual({ ok: true });
  });
});

describe("换目录脚本", () => {
  it("只有 ASCII：Windows PowerShell 5.1 按代码页读没有 BOM 的脚本，中文写进来就是乱码", () => {
    const 非ASCII = [...窗装.换目录脚本].filter((c: string) => c.charCodeAt(0) > 0x7f);
    expect(非ASCII).toEqual([]);
  });
  it("换不成要把旧的改回去；目录被占着就放弃、保留旧版", () => {
    expect(窗装.换目录脚本).toMatch(/rolling back/);
    expect(窗装.换目录脚本).toMatch(/still locked, keep old version/);
  });
  const 解 = (参数: string[]) => Buffer.from(参数[参数.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
  it("起脚本：-EncodedCommand 传命令，不写 .ps1、不靠 -ExecutionPolicy；不 detached；输出落文件", () => {
    const 更新目录 = fs.mkdtempSync(path.join(os.tmpdir(), "更新 目录-"));
    const 启动 = vi.fn(() => ({ unref: vi.fn(), on: vi.fn() }));
    try {
      const { 参数 } = 窗装.启动换目录({
        目录: "C:\\Users\\张三\\Programs\\daedalus-crm", 等PID: 4321, 重启: true, 版本: "0.46.8", exe名: "Daedalus CRM.exe", 更新目录, 启动,
      });
      // 经 cmd /c start "" /b 转一手：PowerShell 不挂在 Electron 的进程树上，按树杀 Electron 时杀不到它
      expect(启动).toHaveBeenCalledWith("cmd.exe", ["/d", "/c", "start", '""', "/b", "powershell.exe", ...参数], expect.objectContaining({ windowsHide: true, windowsVerbatimArguments: true }));
      // 不许 detached：Windows 上那是 DETACHED_PROCESS，PowerShell 5.1 没有控制台就一声不吭地退出（CI 上栽过）
      expect((启动.mock.calls[0] as unknown as [string, string[], { detached?: boolean }])[2].detached).toBeFalsy();
      // 原样拼参数：base64 里不能有空格，不然 cmd 那边就断了
      expect(参数.every((a: string) => !/\s/.test(a))).toBe(true);
      // PowerShell 自己的输出记到文件里：起不来的时候要有线索
      const stdio = (启动.mock.calls[0] as unknown as [string, string[], { stdio: unknown[] }])[2].stdio;
      expect(stdio[0]).toBe("ignore");
      expect(typeof stdio[1]).toBe("number");
      expect(fs.existsSync(path.join(更新目录, "update-swap.out.log"))).toBe(true);
      expect(参数).not.toContain("-File");
      expect(参数).not.toContain("-ExecutionPolicy");
      expect(fs.readdirSync(更新目录).filter((n) => n.endsWith(".ps1"))).toEqual([]);
      const 命令 = 解(参数);
      expect(命令).toContain(窗装.换目录脚本);
      // 中文路径原样进去（UTF-16），数字参数不加引号
      expect(命令).toContain("-Dir 'C:\\Users\\张三\\Programs\\daedalus-crm'");
      expect(命令).toContain("-WaitPid 4321");
      expect(命令).toContain("-Relaunch 1");
      expect(命令).toContain("-Version '0.46.8'");
      expect(命令).toContain("-Exe 'Daedalus CRM.exe'");
    } finally {
      fs.rmSync(更新目录, { recursive: true, force: true });
    }
  });
  it("路径里有单引号（O'Brien 这种用户名）：写两遍，不会把命令截断", () => {
    const 命令 = Buffer.from(窗装.编码命令({ 目录: "C:\\Users\\O'Brien\\app", 日志: "C:\\l.log" }), "base64").toString("utf16le");
    expect(命令).toContain("-Dir 'C:\\Users\\O''Brien\\app'");
  });
});

describe("换目录失败计数：连着换不成就别再下差量", () => {
  let 更新目录: string;
  beforeAll(() => { 更新目录 = fs.mkdtempSync(path.join(os.tmpdir(), "swap-attempts-")); });
  afterAll(() => fs.rmSync(更新目录, { recursive: true, force: true }));
  it("每交给 PowerShell 一次记一笔；同一版本到 2 次就算屡败，换了版本重新数", () => {
    const 启动 = () => ({ unref() {}, on() {} });
    const 换 = (版本: string) => 窗装.启动换目录({ 目录: "C:\\a\\app", 版本, 更新目录, 启动 });
    换("0.46.10");
    expect(窗装.换目录屡败(更新目录, "0.46.10")).toBe(false);
    换("0.46.10");
    expect(窗装.换目录屡败(更新目录, "0.46.10")).toBe(true);
    expect(窗装.换目录屡败(更新目录, "0.46.11")).toBe(false);
    换("0.46.11");
    expect(窗装.换目录屡败(更新目录, "0.46.10")).toBe(false);
  });
  it("启动时已经是那个版本：说明换成了，记录清掉；还是旧版本就留着", () => {
    窗装.记换目录尝试(更新目录, "0.46.12");
    窗装.记换目录尝试(更新目录, "0.46.12");
    窗装.换目录已生效(更新目录, "0.46.11");
    expect(窗装.换目录屡败(更新目录, "0.46.12")).toBe(true);
    窗装.换目录已生效(更新目录, "0.46.12");
    expect(窗装.换目录屡败(更新目录, "0.46.12")).toBe(false);
    expect(fs.existsSync(path.join(更新目录, "swap-attempts.json"))).toBe(false);
  });
});

describe("能不能写：真建一个试，不信 accessSync", () => {
  it("能写的目录说能写，探针用完就删；不存在的目录说不能写", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "可写-"));
    try {
      expect(窗装.可写(d)).toBe(true);
      expect(fs.readdirSync(d)).toEqual([]);
      expect(窗装.可写(path.join(d, "没有这个"))).toBe(false);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("只读目录说不能写", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "只读-"));
    fs.chmodSync(d, 0o555);
    try {
      expect(窗装.可写(d)).toBe(false);
    } finally {
      fs.chmodSync(d, 0o755);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("更新器挑差量资产（GitHub 那一支）", () => {
  afterEach(() => vi.unstubAllGlobals());
  const 资产 = [
    { name: "Daedalus.CRM-1.0.0-arm64.dmg", browser_download_url: "https://g/mac.dmg", digest: `sha256:${"a".repeat(64)}` },
    { name: "Daedalus.CRM-1.0.0-arm64.app.zip", browser_download_url: "https://g/mac.zip" },
    { name: "Daedalus.CRM-1.0.0-arm64.manifest.json.gz", browser_download_url: "https://g/mac.manifest", digest: `sha256:${"c".repeat(64)}` },
    { name: "Daedalus-CRM-1.0.0-x64-setup.exe", browser_download_url: "https://g/setup.exe", digest: `sha256:${"b".repeat(64)}` },
    { name: "Daedalus-CRM-1.0.0-x64-win.zip", browser_download_url: "https://g/win.zip" },
    { name: "Daedalus-CRM-1.0.0-x64-win.manifest.json.gz", browser_download_url: "https://g/win.manifest", digest: `sha256:${"D".repeat(64)}` },
  ];
  function 只有GitHub(assets: unknown[]) {
    vi.stubGlobal("fetch", async (url: string) => {
      if (!String(url).includes("api.github.com")) throw new Error("不通");
      return { ok: true, json: async () => ({ tag_name: "v1.0.0", assets }) };
    });
  }
  it("Windows 拿 -x64-win 的 zip 和清单", async () => {
    只有GitHub(资产);
    const r = await 检查({ 当前版本: "0.46.8", platform: "win32", arch: "x64" });
    expect(r).toMatchObject({ zip: "https://g/win.zip", manifest: "https://g/win.manifest", 清单哈希: "d".repeat(64) });
  });
  it("Mac 不会拿到 Windows 的清单——哪怕列表里 Windows 的排在前面", async () => {
    只有GitHub([...资产].reverse());
    const r = await 检查({ 当前版本: "0.46.8", platform: "darwin", arch: "arm64" });
    expect(r).toMatchObject({ zip: "https://g/mac.zip", manifest: "https://g/mac.manifest", 清单哈希: "c".repeat(64) });
  });
});

describe.skipIf(!有7zip)("整条链：旧安装目录 → CI 的 zip + 清单 → Windows 规则组装", () => {
  let 清单哈希 = "";
  let 沙盒: string, 已装: string, 新: string, 产物: string, server: http.Server, base: string;
  const 统计 = { 字节: 0, 整包请求: 0 };

  function 造(root: string, 变体: "旧" | "新") {
    fs.mkdirSync(path.join(root, "resources", "app.asar.unpacked"), { recursive: true });
    fs.mkdirSync(path.join(root, "locales"), { recursive: true });
    fs.writeFileSync(path.join(root, "Daedalus CRM.exe"), Buffer.alloc(200 * 1024, 3)); // 没变、大
    fs.writeFileSync(path.join(root, "resources", "app.asar"), `asar ${变体}`.repeat(3000)); // 改了
    fs.writeFileSync(path.join(root, "locales", "zh-CN.pak"), "中文资源 ".repeat(500)); // 没变
    fs.writeFileSync(path.join(root, "resources", `chunk-${变体 === "新" ? "b" : "a"}.js`), "same ".repeat(4000)); // 只改了名
    if (变体 === "旧") {
      fs.writeFileSync(path.join(root, "resources", "旧版留下的.txt"), "gone"); // 新版没有
      // NSIS 装的时候放进来的：清单里没有，得从已装的拷过去
      fs.writeFileSync(path.join(root, "Uninstall Daedalus CRM.exe"), "uninstaller");
    }
    if (变体 === "新") fs.writeFileSync(path.join(root, "resources", "app.asar.unpacked", "新增 文件.node"), "native ".repeat(300));
  }

  beforeAll(async () => {
    沙盒 = fs.mkdtempSync(path.join(os.tmpdir(), "win-delta 测试-"));
    已装 = path.join(沙盒, "Programs", "daedalus-crm"); // 目录名和清单里的 win-unpacked 不一样：Windows 不核对
    新 = path.join(沙盒, "dist", "win-unpacked");
    造(已装, "旧");
    造(新, "新");
    产物 = path.join(沙盒, "out");
    execFileSync(process.execPath, [打包脚本, 新, "1.0.0", 产物], { stdio: "pipe" });
    const zip = path.join(产物, "Daedalus-CRM-1.0.0-x64-win.zip");
    const 清单 = path.join(产物, "Daedalus-CRM-1.0.0-x64-win.manifest.json.gz");
    清单哈希 = sha(fs.readFileSync(清单));
    server = http.createServer((req, res) => {
      const f = req.url === "/m" ? 清单 : zip;
      const size = fs.statSync(f).size;
      if (req.method === "HEAD") return res.writeHead(200, { "Content-Length": size }).end();
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
      if (!m) {
        if (req.url !== "/m") 统计.整包请求++;
        res.writeHead(200, { "Content-Length": size });
        return fs.createReadStream(f).pipe(res);
      }
      const [start, end] = [Number(m[1]), Number(m[2])];
      统计.字节 += end - start + 1;
      res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      fs.createReadStream(f, { start, end }).pipe(res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    // beforeAll 中途失败时 server 还没建：别在收尾再报一个错，把真正的原因盖掉
    if (server) await new Promise((r) => server.close(r));
    if (沙盒) fs.rmSync(沙盒, { recursive: true, force: true });
  });

  function 树(root: string) {
    const out: Record<string, string> = {};
    (function 走(d: string) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) 走(p);
        else out[path.relative(root, p).replaceAll("\\", "/")] = sha(fs.readFileSync(p));
      }
    })(root);
    return out;
  }

  it("组装出来和新版逐字节一致、卸载程序在、旧版留下的不在，且只下了变了的", async () => {
    const 估 = await 差量.差量估算({ 清单Url: `${base}/m`, 清单哈希, 已装, 平台: "win32" });
    const r = await 差量.差量组装({ ...估, zipUrl: `${base}/zip`, 已装, 平台: "win32", 运行: async () => { throw new Error("Windows 上不该调外部命令"); } });
    const 拷了 = await 窗装.补齐安装器文件(已装, r.目标);
    expect(拷了).toEqual(["Uninstall Daedalus CRM.exe"]);

    const 期望 = { ...树(新), "Uninstall Daedalus CRM.exe": sha(Buffer.from("uninstaller")) };
    expect(树(r.目标)).toEqual(期望);
    expect(fs.existsSync(path.join(r.目标, "resources", "旧版留下的.txt"))).toBe(false);
    // 改了 app.asar + 新增一个 = 下 2 个；exe、语言包、改名的 chunk 都复用
    expect(r.统计.下载).toBe(2);
    expect(r.统计.复用).toBe(3);
    expect(统计.整包请求).toBe(0);
    expect(统计.字节).toBeLessThan(fs.statSync(path.join(产物, "Daedalus-CRM-1.0.0-x64-win.zip")).size / 2);
  });

  it("写出来的文件都可写：照 zip 里的权限写，Windows 上会全成只读，下次启动删 .old 就删不掉", () => {
    const 只读: string[] = [];
    (function 走(d: string) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) 走(p);
        else if (!(fs.statSync(p).mode & 0o200)) 只读.push(p);
      }
    })(`${已装}.new`);
    expect(只读).toEqual([]);
  });

  it("已装的目录里找不到卸载程序：不能换（换完「应用和功能」就卸不掉了）", async () => {
    const 空 = fs.mkdtempSync(path.join(沙盒, "no-uninst-"));
    await expect(窗装.补齐安装器文件(空, 沙盒)).rejects.toThrow(/卸载程序/);
  });
});

describe.skipIf(process.platform !== "win32")("真的 PowerShell 换目录（Windows）", () => {
  let 沙盒: string, 更新目录: string;
  beforeAll(() => {
    沙盒 = fs.mkdtempSync(path.join(os.tmpdir(), "换 目录 测试-"));
    更新目录 = path.join(沙盒, "updates");
    fs.mkdirSync(更新目录, { recursive: true });
  });
  afterAll(() => fs.rmSync(沙盒, { recursive: true, force: true }));

  function 摆(名: string) {
    const 目录 = path.join(沙盒, "Programs 中文", 名);
    fs.mkdirSync(目录, { recursive: true });
    fs.mkdirSync(`${目录}.new`, { recursive: true });
    fs.writeFileSync(path.join(目录, "a.txt"), "old");
    fs.writeFileSync(path.join(`${目录}.new`, "a.txt"), "new");
    return 目录;
  }
  /** 和应用走同一条路：-EncodedCommand，不带 -ExecutionPolicy */
  function 跑(目录: string, 额外: { 等PID?: number; 版本?: string; 尝试次数?: number } = {}) {
    const 日志 = path.join(更新目录, `${path.basename(目录)}.log`);
    const r = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-EncodedCommand", 窗装.编码命令({ 目录, 日志, ...额外 }),
    ], { encoding: "utf8", timeout: 90_000 });
    return { 退出码: r.status, 日志: fs.existsSync(日志) ? fs.readFileSync(日志, "utf8") : "" };
  }

  it("等指定进程退出后换：旧的成了 .old，新的到了原位", async () => {
    const 目录 = 摆("daedalus-crm");
    const 占位 = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"]);
    const r = 跑(目录, { 等PID: 占位.pid });
    expect(r.退出码, r.日志).toBe(0);
    expect(fs.readFileSync(path.join(目录, "a.txt"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(`${目录}.old`, "a.txt"), "utf8")).toBe("old");
    expect(fs.existsSync(`${目录}.new`)).toBe(false);
    expect(r.日志).toMatch(/swapped/);
  });

  it("目录一直被占着（有进程的当前目录在里面）：放弃，旧版原样留着", async () => {
    const 目录 = 摆("locked-app");
    const 占着 = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { cwd: 目录 });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const r = 跑(目录, { 尝试次数: 4 });
      expect(r.退出码, r.日志).toBe(3);
      expect(fs.readFileSync(path.join(目录, "a.txt"), "utf8")).toBe("old");
      expect(fs.existsSync(`${目录}.new`)).toBe(true);
    } finally {
      占着.kill();
    }
  });

  it("走应用自己的那条路（启动换目录：spawn、不等它、unref）也真能换过去——直接调 PowerShell 的用例抓不到启动方式的问题", async () => {
    // 2026-09-29：原来 detached 启动，PowerShell 没控制台一声不吭就退了；上面几条是 spawnSync 直接调，全绿，没抓到
    const 目录 = 摆("via-app-spawn 中文");
    const 自己的更新目录 = path.join(沙盒, "updates-app");
    窗装.启动换目录({ 目录, 版本: "9.9.9", 更新目录: 自己的更新目录 });
    const 止 = Date.now() + 45_000;
    while (Date.now() < 止 && !(fs.existsSync(`${目录}.old`) && !fs.existsSync(`${目录}.new`))) await new Promise((r) => setTimeout(r, 300));
    const 日志 = (f: string) => (fs.existsSync(path.join(自己的更新目录, f)) ? fs.readFileSync(path.join(自己的更新目录, f), "utf8") : "");
    expect(fs.readFileSync(path.join(目录, "a.txt"), "utf8"), 日志("update-swap.out.log") + 日志("update-swap.log")).toBe("new");
    expect(日志("update-swap.log")).toMatch(/swapped/);
  }, 60_000);

  it("起它的进程被连树杀掉（taskkill /T /F）也照样换过去——Electron 退出时就是这样被带走的", async () => {
    // 2026-09-29 CI：从 node 直接起能换，从 Electron 退出时起就被连树带走，日志一行都没有。
    // 这里造一个「起完就被按树杀掉」的父进程：它起换目录（等它自己的 pid），马上被 taskkill /T /F
    const 目录 = 摆("tree-kill 中文");
    const 更新 = path.join(沙盒, "updates-treekill");
    const 模块 = path.resolve(__dirname, "../desktop/windows-install.js");
    const 父 = spawn(process.execPath, ["-e", `
      const w = require(${JSON.stringify(模块)});
      w.启动换目录({ 目录: ${JSON.stringify(目录)}, 等PID: process.pid, 版本: "9.9.9", 更新目录: ${JSON.stringify(更新)} });
      setTimeout(() => {}, 30000);
    `], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 1500));
    spawnSync("taskkill", ["/pid", String(父.pid), "/T", "/F"]);
    const 止 = Date.now() + 45_000;
    while (Date.now() < 止 && !(fs.existsSync(`${目录}.old`) && !fs.existsSync(`${目录}.new`))) await new Promise((r) => setTimeout(r, 300));
    const 日志 = (f: string) => (fs.existsSync(path.join(更新, f)) ? fs.readFileSync(path.join(更新, f), "utf8") : "");
    expect(fs.readFileSync(path.join(目录, "a.txt"), "utf8"), 日志("update-swap.out.log") + 日志("update-swap.log")).toBe("new");
  }, 60_000);

  it("路径里有单引号和中文也换得过去", () => {
    const 目录 = 摆("O'Brien 的 app");
    const r = 跑(目录);
    expect(r.退出码, r.日志).toBe(0);
    expect(fs.readFileSync(path.join(目录, "a.txt"), "utf8")).toBe("new");
  });

  it("没有 .new：什么都不动", () => {
    const 目录 = path.join(沙盒, "Programs 中文", "no-new");
    fs.mkdirSync(目录, { recursive: true });
    fs.writeFileSync(path.join(目录, "a.txt"), "old");
    expect(跑(目录).退出码).toBe(2);
    expect(fs.readFileSync(path.join(目录, "a.txt"), "utf8")).toBe("old");
  });

  it("「应用和功能」里的版本号跟着改（只改卸载路径指向这个目录的那一条）", () => {
    const 目录 = 摆("with-reg");
    const 键 = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\crm-delta-test-${Date.now()}`;
    const reg = (...a: string[]) => execFileSync("reg.exe", a, { stdio: "pipe" });
    reg("add", 键, "/v", "UninstallString", "/d", `"${目录}\\Uninstall Daedalus CRM.exe" /currentuser`, "/f");
    reg("add", 键, "/v", "DisplayVersion", "/d", "0.46.7", "/f");
    try {
      const r = 跑(目录, { 版本: "0.46.8" });
      expect(r.退出码, r.日志).toBe(0);
      expect(reg("query", 键, "/v", "DisplayVersion").toString()).toMatch(/0\.46\.8/);
    } finally {
      reg("delete", 键, "/f");
    }
  });
});
