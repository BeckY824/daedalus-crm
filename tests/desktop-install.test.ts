/**
 * 应用内更新的安装部分（desktop/install.js）。
 *
 * 真正的 hdiutil / codesign / ditto 用注入的假命令代替，文件系统操作是真的（临时目录）。
 * 钉的是三件事：换包前失败什么都不动；换成之后旧包留成 .old 而不是删掉；
 * 下载半截不会留下一个看起来完整的文件。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const require_ = createRequire(import.meta.url);
const 安装 = require_("../desktop/install.js");

let 沙盒: string;
beforeEach(() => {
  沙盒 = fs.mkdtempSync(path.join(os.tmpdir(), "install-test-"));
});
afterEach(() => fs.rmSync(沙盒, { recursive: true, force: true }));

/** 造一个假的 .app：一个目录，里面一个写着版本号的文件 */
function 造包(位置: string, 版本: string) {
  fs.mkdirSync(path.join(位置, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(位置, "Contents", "version.txt"), 版本);
}
const 读版本 = (位置: string) => fs.readFileSync(path.join(位置, "Contents", "version.txt"), "utf8");

/**
 * 假的命令执行器。hdiutil attach 时在挂载点放一个新版本的 .app；
 * ditto 用真复制；codesign 可以按需失败。记录所有调用便于断言。
 */
function 假命令({ 新版本 = "0.23.0", 签名坏 = false } = {}) {
  const 调用: string[][] = [];
  const 运行 = async (cmd: string, args: string[]) => {
    调用.push([cmd, ...args]);
    if (cmd === "hdiutil" && args[0] === "attach") {
      const 挂载点 = args[args.indexOf("-mountpoint") + 1];
      造包(path.join(挂载点, "Daedalus CRM.app"), 新版本);
    } else if (cmd === "codesign") {
      if (签名坏) throw new Error("codesign 失败：code has no resources but signature indicates they must be present");
    } else if (cmd === "ditto") {
      fs.cpSync(args[0], args[1], { recursive: true });
    }
    return "";
  };
  return { 运行, 调用 };
}

describe("解析应用包", () => {
  it("从可执行文件路径推出 .app", () => {
    expect(安装.解析应用包("/Applications/Daedalus CRM.app/Contents/MacOS/Daedalus CRM")).toBe("/Applications/Daedalus CRM.app");
  });
  it("开发态不在 .app 里", () => {
    expect(安装.解析应用包("/usr/local/lib/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")).toBe(
      "/usr/local/lib/node_modules/electron/dist/Electron.app",
    );
    expect(安装.解析应用包("/opt/homebrew/bin/node")).toBeNull();
  });
});

describe("能原地更新", () => {
  const 可写 = () => true;
  it("正常装在应用程序文件夹里的可以", () => {
    expect(安装.能原地更新("/Applications/Daedalus CRM.app", { platform: "darwin", 可写 })).toEqual({ ok: true });
  });
  it("还在 dmg 里运行的不行——用户根本没装", () => {
    const r = 安装.能原地更新("/Volumes/Daedalus CRM/Daedalus CRM.app", { platform: "darwin", 可写 });
    expect(r.ok).toBe(false);
    expect(r.原因).toContain("安装镜像");
  });
  it("目录不可写的不行", () => {
    const r = 安装.能原地更新("/Applications/Daedalus CRM.app", { platform: "darwin", 可写: () => false });
    expect(r.ok).toBe(false);
    expect(r.原因).toContain("权限");
  });
  it("不是 macOS 的不行；开发态不行", () => {
    expect(安装.能原地更新("C:\\\\x\\\\a.exe", { platform: "win32", 可写 }).ok).toBe(false);
    expect(安装.能原地更新(null, { platform: "darwin", 可写 }).ok).toBe(false);
  });
});

describe("校验sha256", () => {
  it("对得上就过，带不带 sha256: 前缀都行", async () => {
    const f = path.join(沙盒, "a.dmg");
    fs.writeFileSync(f, "hello");
    const h = crypto.createHash("sha256").update("hello").digest("hex");
    await expect(安装.校验sha256(f, h)).resolves.toBeUndefined();
    await expect(安装.校验sha256(f, `sha256:${h.toUpperCase()}`)).resolves.toBeUndefined();
  });
  it("对不上就抛，错误里说清是文件不对", async () => {
    const f = path.join(沙盒, "a.dmg");
    fs.writeFileSync(f, "hello");
    await expect(安装.校验sha256(f, "0".repeat(64))).rejects.toThrow(/校验失败/);
  });
});

describe("下载文件", () => {
  const 假fetch = (体: string, 声称长度?: number, status = 200) => async () => ({
    ok: status === 200,
    status,
    headers: { get: (k: string) => (k === "content-length" && 声称长度 !== undefined ? String(声称长度) : null) },
    body: (async function* () {
      for (const c of 体.match(/.{1,3}/g) ?? []) yield Buffer.from(c);
    })(),
  });

  it("流式落盘，进度回调收到累计字节，完了才改成正式文件名", async () => {
    const 目标 = path.join(沙盒, "u", "a.dmg");
    const 进度: number[] = [];
    await 安装.下载文件({ url: "x", 目标, fetch: 假fetch("0123456789", 10), 进度: (已: number) => 进度.push(已) });
    expect(fs.readFileSync(目标, "utf8")).toBe("0123456789");
    expect(进度.at(-1)).toBe(10);
    expect(fs.existsSync(`${目标}.part`)).toBe(false);
  });

  it("下载不完整（比 content-length 短）要抛，且不留下半截文件", async () => {
    const 目标 = path.join(沙盒, "a.dmg");
    await expect(安装.下载文件({ url: "x", 目标, fetch: 假fetch("0123", 10) })).rejects.toThrow(/不完整/);
    expect(fs.existsSync(目标)).toBe(false);
    expect(fs.existsSync(`${目标}.part`)).toBe(false);
  });

  it("HTTP 不是 200 直接抛", async () => {
    await expect(安装.下载文件({ url: "x", 目标: path.join(沙盒, "a.dmg"), fetch: 假fetch("", undefined, 404) })).rejects.toThrow(/404/);
  });
});

describe("安装dmg", () => {
  it("换成新包，旧包留成 .old（进程还从它里面跑着，不能删），镜像最后被卸载", async () => {
    const 目标 = path.join(沙盒, "Applications", "Daedalus CRM.app");
    造包(目标, "0.22.1");
    const { 运行, 调用 } = 假命令({ 新版本: "0.23.0" });
    await 安装.安装dmg({ dmg: "/tmp/x.dmg", 目标, 运行 });
    expect(读版本(目标)).toBe("0.23.0");
    expect(读版本(`${目标}.old`)).toBe("0.22.1");
    expect(fs.existsSync(`${目标}.new`)).toBe(false);
    expect(调用.map((c) => c[0])).toEqual(["hdiutil", "codesign", "ditto", "hdiutil"]);
    expect(调用.at(-1)?.slice(0, 2)).toEqual(["hdiutil", "detach"]);
  });

  it("新包签名校验失败：什么都不动，镜像照样卸载", async () => {
    const 目标 = path.join(沙盒, "Applications", "Daedalus CRM.app");
    造包(目标, "0.22.1");
    const { 运行, 调用 } = 假命令({ 签名坏: true });
    await expect(安装.安装dmg({ dmg: "/tmp/x.dmg", 目标, 运行 })).rejects.toThrow(/codesign/);
    expect(读版本(目标)).toBe("0.22.1");
    expect(fs.existsSync(`${目标}.old`)).toBe(false);
    expect(fs.existsSync(`${目标}.new`)).toBe(false);
    expect(调用.some((c) => c[0] === "hdiutil" && c[1] === "detach")).toBe(true);
  });

  it("镜像里不是正好一个应用就拒绝", async () => {
    const 目标 = path.join(沙盒, "Applications", "Daedalus CRM.app");
    造包(目标, "0.22.1");
    const 运行 = async (cmd: string, args: string[]) => {
      if (cmd === "hdiutil" && args[0] === "attach") fs.mkdirSync(args[args.indexOf("-mountpoint") + 1], { recursive: true });
      return "";
    };
    await expect(安装.安装dmg({ dmg: "/tmp/x.dmg", 目标, 运行 })).rejects.toThrow(/正好有一个应用/);
    expect(读版本(目标)).toBe("0.22.1");
  });
});

describe("清理旧包", () => {
  it("删掉上次留下的 .old 和 .new，没有也不报错", async () => {
    const 目标 = path.join(沙盒, "Daedalus CRM.app");
    造包(`${目标}.old`, "0.22.1");
    造包(`${目标}.new`, "0.23.0");
    await 安装.清理旧包(目标);
    expect(fs.existsSync(`${目标}.old`)).toBe(false);
    expect(fs.existsSync(`${目标}.new`)).toBe(false);
    await expect(安装.清理旧包(目标)).resolves.toBeUndefined();
    await expect(安装.清理旧包(null)).resolves.toBeUndefined();
  });
});
