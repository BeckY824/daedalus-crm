/**
 * 桌面端的壳（desktop/main.js、preload-app.js、cloud.js）。
 *
 * 2026-09-17 起壳只是壳：登录、退出、找回密码、改密码全在应用页面里，
 * 菜单照 Claude 桌面端那套只留标准项。这里钉的是「别再长回去」——
 * 这些约定跨着三个文件和一段编译器看不见的 IPC 通道名，改坏了不会报错，只会点了没反应。
 *
 * 不起 Electron：真正会坏的不是 DOM 行为，是「引用的东西存不存在」。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 桌面 = path.resolve(__dirname, "../desktop");
const main = fs.readFileSync(path.join(桌面, "main.js"), "utf8");
const preload = fs.readFileSync(path.join(桌面, "preload-app.js"), "utf8");
const cloud = fs.readFileSync(path.join(桌面, "cloud.js"), "utf8");
const 去重 = (xs: string[]) => [...new Set(xs)];

describe("壳里没有账号", () => {
  it("没有登录窗、没有账号菜单、没有那个撒谎的「本机账号密码…」", () => {
    /**
     * 原来壳里另画了一个登录窗（data: URL 拼的 HTML），菜单里有一整组账号项，
     * 于是桌面端有两套身份、两把密码：用户在应用里点了「退出登录」，落到的是一个
     * 要本机随机密码的框；菜单里「本机账号密码…」显示的是建库那一刻的旧密码——
     * 用户在设置里改过之后它就不对了。并成一套之后这些一个都不该再出现。
     */
    for (const 不该有 of ["function 登录云端", "function 必须登录", "显示本机密码", "本机账号密码", 'label: "退出云端账号"', "修改云端账号密码…", "AI 剩余次数…", "登录云端账号…", "cloud-login"]) {
      expect(main.includes(不该有), `main.js 里不该再有「${不该有}」`).toBe(false);
    }
    // 壳这份 cloud.js 只剩读、清、校验——登录退出那些在 src/lib/desktop/cloud.ts
    expect(cloud).toMatch(/module\.exports = \{ 初始化, 读, 清, 校验, 默认云端 \}/);
    for (const 不该有 of ["function 登录(", "function 退出(", "function 模型环境", "function 发码"]) {
      expect(cloud.includes(不该有), `cloud.js 里不该再有「${不该有}」`).toBe(false);
    }
  });

  it("AI 配置不再靠环境变量塞给本地服务——那要登录一次重启一次", () => {
    expect(main).not.toContain("模型环境()");
    expect(main).toContain("CRM_CLOUD_URL: 云端.默认云端");
  });

  it("令牌被吊销：启动时和切回前台时各查一次，失效就送回登录页，不弹框", () => {
    expect(main).toMatch(/if \(云端\.读\(\)\) 启动时被吊销 = \(await 云端\.校验\(\)\)/);
    expect(main).toMatch(/browser-window-focus[\s\S]*?云端\.校验\(\)/);
    const 段 = main.slice(main.indexOf("function 令牌失效了"), main.indexOf("/* ---------- 检查更新"));
    // 经 logout 走：业务会话 cookie 还活着，直接去 /login 会被 proxy 弹回首页
    expect(段).toContain('前往("/api/auth/logout?reason=revoked")');
    expect(段).not.toContain("showMessageBox");
    // cloud.js 那边：401 才清本地那枚；断网当作还认——飞机上打不开自己的 CRM 是更糟的事
    expect(cloud).toContain("r.状态 === 401");
    expect(cloud).toContain("离线: true");
  });
});

describe("菜单照 Claude 桌面端那套：只有标准项", () => {
  const 菜单 = main.slice(main.indexOf("function 建菜单() {"), main.indexOf("/* ---------- 生命周期"));

  it("七组：应用、文件、编辑、显示、前往、窗口、帮助", () => {
    for (const 组 of ['label: "文件"', 'label: "编辑"', 'label: "显示"', 'label: "前往"', 'label: "窗口"', 'label: "帮助"']) {
      expect(菜单, `菜单里少了 ${组}`).toContain(组);
    }
    expect(菜单).toContain('label: "设置…"');
    expect(菜单).toContain('accelerator: "CmdOrCtrl+,"');
  });

  it("账号、备份、日志、诊断那些不在菜单里——它们在设置页「桌面端」那一栏", () => {
    for (const 不该有 of ["备份数据库", "打开数据文件夹", "查看服务日志", "检查更新…", "云端账号"]) {
      expect(菜单.includes(不该有), `菜单里不该有「${不该有}」`).toBe(false);
    }
  });

  it("「前往」覆盖左栏的每一项，路径和 AppShell 里的一致", () => {
    const shell = fs.readFileSync(path.resolve(__dirname, "../src/components/AppShell.tsx"), "utf8");
    const 路径 = 去重([...shell.matchAll(/key: "(\/[a-z-]+)", icon:/g)].map((m) => m[1]));
    expect(路径.length).toBeGreaterThanOrEqual(8);
    for (const p of 路径) expect(菜单, `「前往」里少了 ${p}`).toContain(`"${p}"`);
  });
});

describe("壳给页面的口子", () => {
  it("preload 暴露的、页面调的、主进程处理的，三边对得上", () => {
    /**
     * Electron 里最典型的一类坏法：preload 改了个名字，页面照旧调，
     * 主进程照旧等着另一个通道名——三处任意两处对不上都不报错，只是点了没反应。
     */
    const 通道 = 去重([...preload.matchAll(/ipcRenderer\.invoke\("([\w:-]+)"/g)].map((m) => m[1]));
    expect(通道.length).toBeGreaterThanOrEqual(10);
    for (const ch of 通道) expect(main.includes(`ipcMain.handle("${ch}"`), `preload 会调 ${ch}，主进程没处理它`).toBe(true);

    const 暴露 = 去重([...preload.matchAll(/^\s{2}(\w+): \(/gm)].map((m) => m[1]));
    const tab = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/settings/DesktopTab.tsx"), "utf8");
    const 页面用到 = 去重([...tab.matchAll(/shell[!?]?\.(\w+)\(/g)].map((m) => m[1]));
    expect(页面用到.length).toBeGreaterThanOrEqual(5);
    for (const f of 页面用到) expect(暴露, `设置页调了 desktopShell.${f}()，preload 没暴露它`).toContain(f);
  });

  it("连接服务器只认 http(s)，外链只放站外的出去", () => {
    expect(main).toMatch(/shell:use-server[\s\S]{0,400}\^https\?:\\\/\\\//);
    expect(main).toContain("setWindowOpenHandler");
  });
});
