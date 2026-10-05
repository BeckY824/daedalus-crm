/**
 * R2 · 桌面端「上次停在哪一页」跟着账号走（D-025）。
 *
 * 原来 lastRoute 记在数据根的 config.json 里，不分账号，而且连 query 一起记：
 * 同一台电脑甲退出、乙登录，乙进门就落到甲最后那一页——/customers?keyword=甲搜的字、
 * /dashboard?q=甲问 AI 的那句话；甲的客户记录页在乙库里不存在，乙看到的是「被人删掉了」。
 *
 * 现在记在**各账号自己的数据目录**里（和那份库放在一起：记的页指向的就是那份库里的记录）。
 *
 * 真跑的部分：desktop/accounts.js（认领出两份目录）、desktop/route-memory.js（读 / 记）——原样 require。
 * main.js 引 electron 测不了：本地入口()、记路径、打开到() 三处接线用源码核对钉住（照 r2-shell-backup 读源码的写法）。
 * 不起 Electron、不碰真实数据目录：数据根是系统临时目录里现建的。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const 账号 = require_("../desktop/accounts.js");
const 路径记忆 = require_("../desktop/route-memory.js");
const 根地址 = "http://127.0.0.1:3100";

let 数据根 = "";
beforeEach(() => {
  数据根 = fs.mkdtempSync(path.join(os.tmpdir(), "r2-route-"));
});
afterEach(() => {
  fs.rmSync(数据根, { recursive: true, force: true });
});

/** 照抄 main.js 的 记路径：窗口跳到 url，本地模式下记进当前数据目录 */
function 窗口跳到(数据目录: string, url: string) {
  const p = 路径记忆.可恢复的路径(url, 根地址);
  if (p && p !== 路径记忆.读上次(数据目录)) 路径记忆.记上次(数据目录, p);
}

/** 照抄 main.js 的 本地入口：next 从当前数据目录读 */
function 进门落点(数据目录: string): string | null {
  return 路径记忆.读上次(数据目录);
}

describe("换账号不落到上一个人停的那一页（D-025）", () => {
  it("甲搜过、问过 AI，退出换乙登录：乙进门不带甲的搜索词和问话；甲回来还回到自己那页", () => {
    const 甲 = 账号.认领(数据根, "acc_jia", "jia@x.com").目录;
    窗口跳到(甲, `${根地址}/dashboard?q=${encodeURIComponent("帮我看看王总那单")}`);
    窗口跳到(甲, `${根地址}/customers?keyword=${encodeURIComponent("王总")}`);
    expect(进门落点(甲)).toBe(`/customers?keyword=${encodeURIComponent("王总")}`);

    // 甲退出，乙在同一台电脑登录：认领到乙自己的目录
    账号.退出(数据根);
    const 乙 = 账号.认领(数据根, "acc_yi", "yi@x.com").目录;
    expect(乙).not.toBe(甲);
    expect(进门落点(乙), "乙进门落到了甲最后停的那一页").toBeNull();

    窗口跳到(乙, `${根地址}/leads?keyword=${encodeURIComponent("乙的线索")}`);
    expect(进门落点(乙)).toBe(`/leads?keyword=${encodeURIComponent("乙的线索")}`);

    // 甲再回来：回到他自己那页，不是乙的
    账号.退出(数据根);
    const 甲又 = 账号.认领(数据根, "acc_jia", "jia@x.com").目录;
    expect(甲又).toBe(甲);
    expect(进门落点(甲又)).toBe(`/customers?keyword=${encodeURIComponent("王总")}`);
  });

  it("老配置里那条不分账号的 lastRoute 不再被本地模式拿来当落点", () => {
    fs.writeFileSync(path.join(数据根, "config.json"), JSON.stringify({ mode: "local", lastRoute: "/customers?keyword=甲" }));
    const 乙 = 账号.认领(数据根, "acc_yi", "yi@x.com").目录;
    expect(进门落点(乙)).toBeNull();
  });

  it("读上次只认站内应用路径：文件坏了、被改成登录页或外站，一律当没记过", () => {
    const 目录 = 账号.认领(数据根, "acc_jia").目录;
    expect(路径记忆.读上次(目录)).toBeNull();
    路径记忆.记上次(目录, "/customers/abc");
    expect(路径记忆.读上次(目录)).toBe("/customers/abc");
    const 文件 = fs.readdirSync(目录).find((f: string) => /route/i.test(f));
    expect(文件, "记在账号目录里").toBeTruthy();
    for (const 坏 of ["{不是 JSON", JSON.stringify({ route: "/login" }), JSON.stringify({ route: "//evil.com/x" }), JSON.stringify({ route: 42 }), JSON.stringify({ route: "https://evil.com" })]) {
      fs.writeFileSync(path.join(目录, 文件!), 坏);
      expect(路径记忆.读上次(目录), 坏).toBeNull();
    }
    // 目录不存在也不抛
    expect(路径记忆.读上次(path.join(数据根, "没有这个目录"))).toBeNull();
    expect(() => 路径记忆.记上次(path.join(数据根, "没有这个目录", "更深"), "/x")).not.toThrow();
  });
});

describe("main.js 接线（源码核对）", () => {
  // Windows 上签出的是 CRLF，切函数体按 "\n}\n" 找：先统一成 LF
  const 源 = fs.readFileSync(path.resolve(__dirname, "../desktop/main.js"), "utf8").replaceAll("\r\n", "\n");
  const 函数体 = (名: string) => {
    const i = 源.indexOf(`function ${名}(`);
    expect(i, `main.js 里找不到 ${名}()`).toBeGreaterThan(-1);
    return 源.slice(i, 源.indexOf("\n}\n", i));
  };

  it("本地入口() 的 next 从当前数据目录读，不再读 config.json 的 lastRoute", () => {
    const 体 = 函数体("本地入口");
    expect(体).toMatch(/路径记忆\.读上次\(数据目录\)/);
    expect(体).not.toMatch(/lastRoute/);
  });

  it("记路径、打开到() 在本地模式下记进当前数据目录", () => {
    const 记 = 源.slice(源.indexOf("const 记路径 ="), 源.indexOf('win.webContents.on("did-navigate", 记路径)'));
    expect(记).toMatch(/路径记忆\.记上次\(数据目录, p\)/);
    expect(函数体("打开到")).toMatch(/路径记忆\.记上次\(数据目录, 路径\)/);
  });
});
