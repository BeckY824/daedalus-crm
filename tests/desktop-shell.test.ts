/**
 * 桌面端的壳（desktop/main.js、preload-app.js、cloud.js）。
 *
 * 2026-09-17 起壳只是壳：登录、退出、找回密码、改密码全在应用页面里，
 * 菜单照 Claude 桌面端那套只留标准项。这里钉的是「别再长回去」——
 * 这些约定跨着三个文件和一段编译器看不见的 IPC 通道名，改坏了不会报错，只会点了没反应。
 *
 * 不起 Electron：真正会坏的不是 DOM 行为，是「引用的东西存不存在」。
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
    // 启动那次只等 5 秒（2026-10-02 排查桌面端 D3），所以括号里带着超时
    expect(main).toMatch(/if \(云端\.读\(\)\) \{[\s\S]{0,800}?云端\.校验\([^)]*\)[\s\S]{0,400}?启动时被吊销/);
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
    /*
      只在某个模版下才出现的入口（2026-10-03 起：外贸模版的「订单」）不进菜单：壳不知道这个库用的哪个模版，
      放进去的话通用销售的人也会看到一个用不上的「订单」。它们写成 `b.template === "…" ? [{ key: … }]`，按这个认出来排掉。
    */
    // 也认「模版 && 功能开关」（2026-10-04：订单 / 供应商这一版不上，lib/features.ts）
    const 按模版 = new Set([...shell.matchAll(/b\.template === "\w+"(?: && [^?]+)? \? \[\{ key: "(\/[a-z-]+)"/g)].map((m) => m[1]));
    expect(按模版.has("/orders")).toBe(true);
    const 路径 = 去重([...shell.matchAll(/key: "(\/[a-z-]+)", icon:/g)].map((m) => m[1])).filter((p) => !按模版.has(p));
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

  it("页面能传的只有标题、正文、去处三段字；去处只认站内相对路径，弹什么在壳里定死", () => {
    expect(preload).toMatch(/通知: \(标题, 正文, 去\) => ipcRenderer\.invoke\("notify:show", \{ 标题: String\(/);
    const 段 = main.slice(main.indexOf('ipcMain.handle("notify:show"'));
    expect(段.slice(0, 900)).toContain("new Notification({ title, body:");
    expect(段.slice(0, 900)).toContain("站内路径(内容?.去)");
    // 站内路径 的规则：/ 开头、不是 //、不带空白和反斜杠
    const 规则 = /function 站内路径\(v\) \{[\s\S]*?return (\/.+\/)\.test/.exec(main)?.[1];
    expect(规则).toBeTruthy();
    const re = new RegExp(规则!.slice(1, -1));
    for (const ok of ["/customers/abc", "/follow-ups/plans", "/customers/a?focus=plan%3Ap1"]) expect(re.test(ok), ok).toBe(true);
    for (const bad of ["//evil.com", "https://evil.com", "javascript:alert(1)", "/a b", "/a\\b", ""]) expect(re.test(bad), bad).toBe(false);
  });

  it("点一下：有去处就去那儿，没有就把窗口叫到前面——不然人不知道该去哪看", () => {
    const 段 = main.slice(main.indexOf('ipcMain.handle("notify:show"'), main.indexOf('ipcMain.handle("shell:version"'));
    expect(段).toContain('n.on("click"');
    expect(段).toContain("if (去处) return 打开到(去处)");
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
    // 2026-10-04 修 B-2：改用 是他的()——accounts/<key> 的 .owner 被清空时认目录名，不再当「没主」放过去
    expect(看).toContain("账号.是他的(数据目录, c.accountId)");
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
    for (const f of ["LoginForm.tsx", "after-login.ts", "DesktopAuth.tsx"]) {
      const form = fs.readFileSync(path.resolve(__dirname, `../src/app/login/${f}`), "utf8");
      expect(form, f).not.toContain("void window.desktopShell.switchAccount()");
    }
  });
});

/**
 * 从 main.js 里按名字取出一个函数的整段源码（数大括号，跳过字符串和模板串里的括号）。
 * 壳是裸 JS、顶层一 require 就要 Electron，单测起不来它；取出那一段在沙箱里跑，
 * 测的就是 main.js 里**真在用的那几行**，不是照抄的一份（照抄的改了原处不会红）。
 */
function 取函数(src: string, 名: string): string {
  const 头 = src.search(new RegExp(`(?:async )?function ${名}\\(`));
  if (头 < 0) throw new Error(`main.js 里找不到 function ${名}`);
  let i = src.indexOf("{", src.indexOf(")", 头));
  let 深 = 0;
  let 引号: string | null = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (引号) {
      if (c === "\\") i++;
      else if (c === 引号) 引号 = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") 引号 = c;
    else if (c === "{") 深++;
    else if (c === "}" && --深 === 0) return src.slice(头, i + 1);
  }
  throw new Error(`function ${名} 的括号没配平`);
}

describe("本机服务起不来、起两次（回归核对 D-035 / D-036 / R-016）", () => {
  it("D-035 故障框只给「重试 / 查看完整日志 / 退出」，没有「改用服务器」（那会把人带进托管版的共享试用账号）", () => {
    const 段 = 取函数(main, "报告本地故障");
    expect(段).toMatch(/buttons: \["重试", "查看完整日志", "退出"\]/);
    expect(段).not.toContain("改用服务器");
    expect(段).not.toContain("连服务器(");
  });

  it("D-036 启动本地 同一时间只起一次：连点两下只起一个服务，两处拿到的是同一次；起完了下次还能再起", async () => {
    const 源 = main.slice(main.indexOf("let 启动中 = null;"), main.indexOf("async function 真启动本地"));
    expect(源).toContain("function 启动本地()");
    let 起了几次 = 0;
    let 放行!: () => void;
    const 真启动本地 = () => {
      起了几次++;
      return new Promise<void>((r) => (放行 = r));
    };
    const 启动本地 = new Function("真启动本地", `${源}; return 启动本地;`)(真启动本地) as () => Promise<void>;
    const 甲 = 启动本地();
    const 乙 = 启动本地();
    expect(起了几次, "第二下不该另起一个服务").toBe(1);
    expect(乙).toBe(甲);
    放行();
    await Promise.all([甲, 乙]);
    // 上一次结束了（成功或失败），「重试」要真的再起
    void 启动本地();
    expect(起了几次).toBe(2);
  });

  it("D-036 起失败了：两处都拿到失败，单飞的位子也让出来——「重试」不会一直等一个已经死掉的那次", async () => {
    const 源 = main.slice(main.indexOf("let 启动中 = null;"), main.indexOf("async function 真启动本地"));
    let 起了几次 = 0;
    const 真启动本地 = () => (++起了几次 === 1 ? Promise.reject(new Error("端口被占")) : Promise.resolve());
    const 启动本地 = new Function("真启动本地", `${源}; return 启动本地;`)(真启动本地) as () => Promise<void>;
    const [a, b] = await Promise.allSettled([启动本地(), 启动本地()]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    await 启动本地();
    expect(起了几次).toBe(2);
  });
});

describe("config.json：写进去的每一项读配置都要读回来（回归核对 D-034）", () => {
  it("扫 main.js 里所有 写配置({ ...读配置(), X })：X 的每个键，读配置() 都原样还回来", () => {
    // 读配置() 是白名单返回：新写进 config 的键要是没加进白名单，下一次任何一处 写配置({...读配置()}) 就把它抹掉（glass、skipVersion 都栽过）
    const 键们 = new Set<string>();
    for (const m of main.matchAll(/写配置\(\{ \.\.\.读配置\(\), ([^}]*)\}\)/g)) {
      for (const 段 of m[1].split(",")) {
        const 键 = 段.split(":")[0].trim();
        if (键) 键们.add(键);
      }
    }
    // 只有展开写的那几种：整个换掉的写法（写配置({ mode, serverUrl })）就是当初抹掉配置的那个坑
    expect(main.match(/写配置\(\{(?!\s*\.\.\.读配置\(\))/g), "写配置 只许 {...读配置(), 改的那几项} 这一种写法").toBeNull();
    expect([...键们].sort()).toEqual(["glass", "lastRoute", "lastUpdateCheck", "mode", "serverUrl"]);

    const 目录 = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
    try {
      const CONFIG_FILE = path.join(目录, "config.json");
      const 值: Record<string, unknown> = { glass: false, lastRoute: "/customers/abc", lastUpdateCheck: "2026-10-04T00:00:00.000Z", mode: "local", serverUrl: "https://crm.example.com" };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(值));
      const 读配置 = new Function("fs", "path", "CONFIG_FILE", "旧数据目录", "数据根", "默认服务器", `${取函数(main, "读配置")}; return 读配置;`)(
        fs, path, CONFIG_FILE, 目录, 目录, "https://default.example.com",
      ) as () => Record<string, unknown>;
      const 读回 = 读配置();
      for (const 键 of 键们) expect(读回[键], `读配置() 没把 ${键} 读回来，下一次写配置就会把它抹掉`).toEqual(值[键]);
    } finally {
      fs.rmSync(目录, { recursive: true, force: true });
    }
  });
});

describe("检查更新：整包不自动下、重试不弹框（回归核对 D-083 / R-010 / R-007 / D-088）", () => {
  const 查 = 取函数(main, "检查更新");

  it("D-083 / R-010 只有差量才自动下；整包先出按钮，点了才下（自动下 160 MB 会占满网、断了还从头来）", () => {
    expect(查).toMatch(/自动下 = 计划\.方式 === "差量";/);
    // 检查更新 里叫 下载更新 的只有「自动下」那一处
    expect(查.match(/下载更新\(\)/g)).toHaveLength(1);
    expect(查).toMatch(/if \(自动下\) (?:await |void )?下载更新\(\)(?:\.catch|;)/);
    // 整个壳里叫 下载更新 的只有：检查更新 那一处、点「更新到 x」的 IPC。定时器、切回前台都只是查
    const 叫的地方 = [...main.matchAll(/下载更新\(\)/g)].map((m) => main.slice(Math.max(0, m.index! - 80), m.index! + 12));
    expect(叫的地方.filter((x) => !/function 下载更新\(\)/.test(x))).toHaveLength(2);
    expect(main).toMatch(/ipcMain\.handle\("update:download", \(\) => 下载更新\(\)\)/);
    expect(main).toMatch(/setTimeout\(\(\) => 检查更新\(\)\.catch/);
  });

  it("R-007 查都没查成时点左栏「更新失败，点击重试」：重查是静默的，不弹系统框「已经是最新版本」", () => {
    const 下 = 取函数(main, "下载更新");
    expect(下).toMatch(/if \(!计划\) return 检查更新\(\{ 手动: true, 静默: true \}\);/);
    // 静默压过手动：三个弹框都只在 手动 时弹
    expect(查).toMatch(/if \(静默\) 手动 = false;/);
    for (const m of 查.matchAll(/dialog\.showMessageBox/g)) {
      expect(查.slice(Math.max(0, m.index! - 20), m.index!), "检查更新 里的系统框都得挂在 if (手动) 后面").toMatch(/if \(手动\) $/);
    }
  });

  it("D-088 实际检查函数在差量下载挂起时返回，后台失败转错误态", async () => {
    let fail!: (e: Error) => void;
    const download = vi.fn(() => new Promise((_r, reject) => { fail = reject; }));
    const states: { 阶段: string }[] = [];
    const log = vi.fn();
    const check = new Function("下载更新", "设更新状态", "崩溃", `
      let 正在查=false,更新状态={阶段:'idle'},计划; const app={getVersion:()=>'.15',isPackaged:true};
      const 更新={检查:async()=>({版本:'.16',sha256:'a'.repeat(64),dmg:'https://test/a.dmg',zip:'https://test/a.zip',manifest:'https://test/a.json'})};
      const process={platform:'darwin',arch:'arm64'},path={join:()=>''},数据根='',应用包='',应用日志='';
      const 安装={能原地更新:()=>({ok:true})},窗装={},写配置=()=>{},读配置=()=>({}),dialog={};
      const 差量={差量估算:async()=>({清单:{},比对结果:{},要下:100})};
      const 先主后备=async(a,b,run)=>run(a,false);
      ${查}; return 检查更新;
    `)(download, (s: { 阶段: string }) => states.push(s), { 写崩溃日志: log }) as () => Promise<void>;
    await check();
    expect(download).toHaveBeenCalledOnce();
    expect(states.at(-1)?.阶段).toBe("available");
    fail(new Error("QA download failed"));
    await Promise.resolve(); await Promise.resolve();
    expect(states.at(-1)?.阶段).toBe("error"); expect(log).toHaveBeenCalledOnce();
  });

  it("D-088 没有新版时静默检查只推checking→idle，菜单检查才显示系统框", async () => {
    const states: { 阶段: string }[] = []; const show = vi.fn();
    const check = new Function("设更新状态", "dialog", `
      let 正在查=false,更新状态={阶段:'idle'};const app={getVersion:()=>'.16'},win=null;
      const 更新={检查:async()=>null},process={platform:'darwin',arch:'arm64'},写配置=()=>{},读配置=()=>({});
      ${查};return 检查更新;
    `)((s: { 阶段: string }) => states.push(s), { showMessageBox: show });
    await check({ 手动: true, 静默: true });
    expect(states.map(x => x.阶段)).toEqual(["checking", "idle"]); expect(show).not.toHaveBeenCalled();
    await check({ 手动: true });
    expect(show).toHaveBeenCalledOnce(); expect(show.mock.calls[0][1].message).toBe("已经是最新版本");
  });
});

describe("启动与第二个实例（回归核对 D-030）", () => {
  it("D-030 启动时那次校验只等 5 秒（原来 20 秒、窗口都没建，人以为应用坏了）", () => {
    const 启动段 = main.slice(main.indexOf('app.on("second-instance"'), main.indexOf("app.on(\"before-quit\""));
    expect(启动段).toMatch(/if \(云端\.读\(\)\) \{[\s\S]{0,800}?const r = await 云端\.校验\(5_000\);/);
    // 切回前台那次（窗口已经在了）照旧用默认超时，不在这里改
    expect(cloud).toMatch(/function 校验\(/);
  });

  it("D-030 启动中的重复打开只建一个提示窗；已有窗口则恢复、显示并聚焦", () => {
    const windows: Array<{ show: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> }> = [];
    const ready: Array<() => void> = [];
    class FakeWindow {
      show = vi.fn(); focus = vi.fn(); isDestroyed = () => false;
      once(_name: string, cb: () => void) { ready.push(cb); }
      loadURL = () => Promise.resolve();
      constructor() { windows.push(this); }
    }
    let isReady = false; let onReady!: () => void;
    const app = { isReady: () => isReady, once: (_name: string, cb: () => void) => { onReady = cb; } };
    const api = new Function("app", "BrowserWindow", `let win=null,过渡小窗=null,启动要聚焦=false;
      ${取函数(main, "聚焦或提示启动")};return {run:聚焦或提示启动,setWin:w=>win=w,pending:()=>启动要聚焦};`)(app, FakeWindow);
    api.run(); expect(windows).toHaveLength(0); expect(api.pending()).toBe(true);
    isReady = true; onReady(); ready[0](); api.run();
    expect(windows).toHaveLength(1); expect(windows[0].show).toHaveBeenCalledTimes(2);
    const window = { isDestroyed: () => false, isMinimized: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
    api.setWin(window); api.run();
    expect(window.restore).toHaveBeenCalledOnce(); expect(window.show).toHaveBeenCalledOnce(); expect(window.focus).toHaveBeenCalledOnce();
    expect(main).toContain('app.on("second-instance", 聚焦或提示启动)');
    expect(取函数(main, "建窗口")).toContain("if (启动要聚焦)");
  });
});

describe("毛玻璃关着时的透明窗（回归核对 D-118）", () => {
  it("transparent 只能建窗口时给，所以 Mac 一律建透明窗；关着时底色是实底、模糊半径 0——看上去就是不透明的窗口", () => {
    // 建窗口：透明窗的底色跟着 玻璃开着() 走
    expect(取函数(main, "建窗口")).toMatch(/transparent: true, backgroundColor: 玻璃开着\(\) \? "#00000000" : 实底/);
    const 记 = { 模糊: [] as number[], 底色: [] as string[] };
    const 假窗 = { isDestroyed: () => false, setBackgroundColor: (c: string) => 记.底色.push(c), setVibrancy: () => {} };
    const 模糊 = { 设模糊: (_w: unknown, r: number) => 记.模糊.push(r) };
    const 上玻璃 = new Function("透明窗", "模糊", "模糊半径", "实底", "process", `${取函数(main, "上玻璃")}; return 上玻璃;`)(
      true, 模糊, 60, "#fafafa", { platform: "darwin" },
    ) as (w: unknown, 开: boolean) => void;
    上玻璃(假窗, false);
    expect(记).toEqual({ 模糊: [0], 底色: ["#fafafa"] });
    上玻璃(假窗, true);
    expect(记).toEqual({ 模糊: [0, 60], 底色: ["#fafafa", "#00000000"] });
  });
});
