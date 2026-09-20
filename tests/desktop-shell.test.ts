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
    /*
      壳这份 cloud.js 只剩读、清、校验——登录退出那些在 src/lib/desktop/cloud.ts。
      按「不该有什么」钉，不按「导出那一行长什么样」钉：原来写死了整行 module.exports，
      于是 0.39.2 加一个 读账号id（给 accounts.js 迁移用的）就把它碰红了，
      而那次改动和「壳里有没有账号」这件事毫无关系。
    */
    const 导出 = (cloud.match(/module\.exports = \{([^}]*)\}/)?.[1] ?? "").split(",").map((x) => x.trim());
    for (const 该有 of ["读", "清", "校验"]) expect(导出, `cloud.js 该导出 ${该有}`).toContain(该有);
    for (const 不该有 of ["function 登录(", "function 退出(", "function 模型环境", "function 发码"]) {
      expect(cloud.includes(不该有), `cloud.js 里不该再有「${不该有}」`).toBe(false);
    }
  });

  it("AI 配置不再靠环境变量塞给本地服务——那要登录一次重启一次", () => {
    expect(main).not.toContain("模型环境()");
    expect(main).toContain("CRM_CLOUD_URL: 云端.默认云端");
  });

  it("令牌被吊销：启动时和切回前台时各查一次，失效就送回登录页，不弹框", () => {
    // 启动那一下：读到令牌就去校验，结果决定 启动时被吊销。
    // 不钉整行——0.39.2 起这里还要顺手认领数据目录（见 desktop/accounts.js），
    // 那一段把单行拆成了一个块，但「启动时校验一次」这件事没变。
    expect(main).toMatch(/if \(云端\.读\(\)\) \{[\s\S]{0,400}?云端\.校验\(\)[\s\S]{0,400}?启动时被吊销/);
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

  it("菜单里的「设置」走软导航：三个文件里的通道名得对得上", () => {
    /**
     * ⌘, 打开的必须是**盖在当前页上的那一层**，和账号菜单里点「设置」同一个样子。
     * 拦截路由只认软导航，所以壳不能 loadURL，得让页面自己 push——
     * 这条路横跨主进程、preload 和 AppShell 三个文件，一个通道名写岔就是「按了没反应」。
     */
    expect(main).toContain('win.webContents.send("nav:go"');
    expect(main).toContain('ipcMain.once("nav:ok"');
    expect(preload).toContain('ipcRenderer.on("nav:go"');
    expect(preload).toContain('ipcRenderer.send("nav:ok")');
    // 设置那两个菜单项都不许再走硬跳转
    expect(main).toMatch(/设置…[^\n]*click: \(\) => 去\(/);
    expect(main).toMatch(/label: "设置", click: \(\) => 去\("\/settings"\)/);
    // 对面没人接时还得有退路：没有这一段，登录页上按 ⌘, 就真的什么都不会发生
    expect(main).toMatch(/应答了[\s\S]{0,200}前往\(路径\)/);

    const shell = fs.readFileSync(path.resolve(__dirname, "../src/components/AppShell.tsx"), "utf8");
    expect(shell).toContain("window.desktopNav?.onGo");
  });

  it("连接服务器只认 http(s)，外链只放站外的出去", () => {
    expect(main).toMatch(/shell:use-server[\s\S]{0,400}\^https\?:\\\/\\\//);
    expect(main).toContain("setWindowOpenHandler");
  });
});

/**
 * 打包清单。
 *
 * 2026-09-18 线上炸过一次：新加的 `desktop/mcp-bridge.js` 没写进
 * `desktop/package.json` 的 `files` 白名单，`app.asar` 里就没有这个文件，
 * 应用一启动就 `Cannot find module './mcp-bridge'`，**整个打不开**。
 * 本地 `npm run dev` 一切正常——那条路不走 asar，压根不看白名单。
 *
 * 所以这条用例把「壳里 require 了哪些本地文件」和白名单对一遍：
 * 加文件忘了改白名单，在这儿就红，而不是等用户装上之后白屏。
 */
describe("打包清单要盖住壳里 require 的每个文件", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(桌面, "package.json"), "utf8")) as { build?: { files?: string[] } };
  const 白名单 = pkg.build?.files ?? [];
  /** 壳里所有 require("./x") 的文件名（只看相对路径的，node_modules 由打包器自己管） */
  const 本地依赖 = 去重(
    fs
      .readdirSync(桌面)
      .filter((f) => f.endsWith(".js"))
      .flatMap((f) => [...fs.readFileSync(path.join(桌面, f), "utf8").matchAll(/require\(["']\.\/([\w-]+)["']\)/g)].map((m) => `${m[1]}.js`)),
  );

  it("每个被 require 的本地文件都在 files 白名单里", () => {
    const 漏了 = 本地依赖.filter((f) => !白名单.includes(f));
    expect(漏了, `这些文件壳里 require 了，但不会被打进 app.asar：${漏了.join("、")}`).toEqual([]);
  });

  it("白名单里也不该有已经删掉的文件", () => {
    const 不存在 = 白名单.filter((f) => f.endsWith(".js") && !fs.existsSync(path.join(桌面, f)));
    expect(不存在, `白名单里这些文件不存在了：${不存在.join("、")}`).toEqual([]);
  });
});

/**
 * 「跑完了叫你一声」（2026-09-19）。
 *
 * AI 问一句要十几秒，人会切去别的应用——侧栏那条进度只在窗口里有用。
 * 这条链跨三处：页面调 window.desktopNotify → preload 的 IPC 通道 → 主进程弹。
 * 通道名是一段编译器看不见的字符串，改坏了不报错，只是点完以后**永远不响**。
 */
describe("跑完了叫人一声", () => {
  const 页面 = fs.readFileSync(path.resolve(__dirname, "../src/components/AiTasks.tsx"), "utf8");

  it("三处对着同一个通道名", () => {
    expect(preload).toContain('exposeInMainWorld("desktopNotify"');
    expect(preload).toContain('ipcRenderer.invoke("notify:show"');
    expect(main).toContain('ipcMain.handle("notify:show"');
    expect(页面).toContain("window.desktopNotify?.通知(");
  });

  it("窗口在前台就不弹——侧栏那一条已经说了，再弹一个是吵", () => {
    const 段 = main.slice(main.indexOf('ipcMain.handle("notify:show"'));
    expect(段.slice(0, 600)).toContain("win.isFocused()");
  });

  it("前台与否只在壳这一处判断，页面不跟着判一遍（两处迟早不一致）", () => {
    expect(页面).not.toContain("hasFocus");
    expect(页面).not.toContain("document.hidden");
  });

  it("页面只能传两段字，弹什么、点了干什么都在壳里定死", () => {
    // 页面传得进来的就是标题和正文，别的字段一概不看
    expect(preload).toMatch(/通知: \(标题, 正文\) => ipcRenderer\.invoke\("notify:show", \{ 标题: String\(/);
    const 段 = main.slice(main.indexOf('ipcMain.handle("notify:show"'));
    expect(段.slice(0, 900)).toContain("new Notification({ title, body:");
  });

  it("点一下把窗口叫到前面来——不然人不知道该去哪看", () => {
    const 段 = main.slice(main.indexOf('ipcMain.handle("notify:show"'), main.indexOf('ipcMain.handle("shell:version"'));
    expect(段).toContain('n.on("click"');
    expect(段).toContain("win.focus()");
  });
});

/**
 * 换账号要换数据目录，而这件事**不许挂在页面的配合上**。
 *
 * 2026-09-20 用户报的那个 bug：换了账号登录，看到的还是上一个账号的客户。
 * 当时换目录只有一条路——登录页调 `desktopShell.switchAccount()`。桥不在就没人接，
 * 而且那一声是 `void` 出去的，失败了页面也不知道。现在壳自己盯着令牌文件，
 * 页面那一声只是提速；服务端另有一道「对不上就不给进」的闸（desktop-session.test.ts）。
 */
describe("换账号：壳自己发现，不等页面", () => {
  it("盯着数据目录里的 .cloud.json，一变就自己去换", () => {
    expect(main).toContain("function 盯住凭据(");
    expect(main).toMatch(/fs\.watch\(dir/);
    // 只认令牌文件那几下：同一个目录里 crm.db 一直在写
    expect(main).toContain('startsWith(".cloud.json")');
  });

  it("监视跟着「唯一入口」走：目录一换，盯的就是新目录", () => {
    const 入口 = main.slice(main.indexOf("function 换数据目录("), main.indexOf("function 盯住凭据("));
    expect(入口).toContain("盯住凭据(dir)");
  });

  it("归属和令牌对不上才换，且没登录时目录一个字节都不动", () => {
    const 看 = main.slice(main.indexOf("async function 看凭据换没换()"), main.indexOf("/** 随包发布的本地服务"));
    expect(看).toContain("账号.归谁(数据目录)");
    expect(看).toContain("c?.accountId");
  });

  it("令牌跟着人走：换目录时把 .cloud.json 一起搬过去，两条路都搬", () => {
    // 不搬的话：新目录里没有令牌，人登录完又落回登录页；而旧目录里躺着的是别人的令牌
    const 启动 = main.slice(main.indexOf("if (r.accountId) {"), main.indexOf("// 没登录也照起"));
    expect(启动).toContain("搬令牌(数据目录, 目标.目录)");
    const 切 = main.slice(main.indexOf("async function 切一次()"));
    expect(切).toContain("搬令牌(数据目录, 目标.目录)");
    expect(main).toContain("function 搬令牌(");
  });

  it("页面那一声和壳自己发现的，进的是同一个 切账号()，同一时刻只切一次", () => {
    expect(main).toContain('ipcMain.handle("shell:switch-account", () => 切账号())');
    expect(main).toContain("let 切换中 = null");
    // 页面那一声不能再是 void 出去就不管了——换不成得把人挡住
    const form = fs.readFileSync(path.resolve(__dirname, "../src/app/login/LoginForm.tsx"), "utf8");
    expect(form).not.toContain("void window.desktopShell.switchAccount()");
  });
});
