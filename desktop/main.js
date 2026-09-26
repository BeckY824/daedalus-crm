/**
 * Daedalus CRM 桌面客户端——**只是壳**。
 *
 * 两种模式，同一个安装包：
 *   本地   —— 数据和服务都在这台机器上，装完就能用，不需要服务器
 *             （AI 功能除外，那要连模型接口）
 *   服务器 —— 连一台已经部署好的实例，团队共用一份数据
 *
 * 新装的默认是本地；从旧版本升上来的保持原样连服务器，见 读配置()。
 *
 * 本地模式**必须登录云端账号**（2026-09-15 起）：账号免费、邮箱注册，
 * 数据仍然只在本机，账号只用来记 AI 次数。**登录、退出、找回密码、改密码全在应用页面里**
 * （2026-09-17 起，src/lib/desktop/cloud.ts）——壳不再画登录窗，菜单里也没有账号。
 * 原来壳里另有一套，桌面端就有了两套身份、两扇门、两把密码，用户在应用里点了
 * 「退出登录」，落到的是一个要本机随机密码的框。壳现在只管：起本地服务、开窗口、
 * 启动和切回前台时问一句令牌还认不认、更新、以及菜单里那几个标准项。
 *
 * 菜单照 Claude 桌面端那套：应用 / 文件 / 编辑 / 显示 / 前往 / 窗口 / 帮助，全是标准项。
 * 备份、日志、诊断、连接服务器这些搬进了设置页「桌面端」那一栏（preload-app.js 的 desktopShell）。
 */
const { app, BrowserWindow, Notification, shell, dialog, Menu, clipboard, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const 本地服务 = require("./local-server");
const MCP桥 = require("./mcp-bridge");
const 云端 = require("./cloud");
const 账号 = require("./accounts");
const 机器 = require("./machine");
const 更新 = require("./updater");
const 安装 = require("./install");
const 路径记忆 = require("./route-memory");
const 差量 = require("./delta");
const 备份 = require("./backup");
const 崩溃 = require("./crashlog");
const os = require("node:os");

const APP_NAME = "Daedalus CRM";
if (process.platform === "win32") app.setAppUserModelId("com.daedalus.crm");

/**
 * 把用户数据目录挪到一个**不含空格**的路径下。
 *
 * 默认会是 ~/Library/Application Support/Daedalus CRM —— 名字里有空格，
 * 而数据库地址是以 `file:` URL 的形式交给 Prisma 的，空格在那里是雷。
 * 必须在 app ready 之前改，否则 Electron 自己的缓存已经落在旧路径上了。
 */
const 旧数据目录 = app.getPath("userData");
/**
 * CRM_DATA_ROOT：把整个数据根挪到别处，只给本机联调用——用一份隔离的数据、隔离的单实例锁，
 * 起第二个实例来测，而不碰装在机器上那个正在用的应用。macOS 的 appData 不认 $HOME，
 * 所以改 HOME 没用，只能从这里给。发出去的包里没人会设它。
 */
app.setPath("userData", process.env.CRM_DATA_ROOT || path.join(app.getPath("appData"), "DaedalusCRM"));
const 数据根 = app.getPath("userData");

const CONFIG_FILE = path.join(数据根, "config.json");
/**
 * 数据目录**一个云端账号一份**（0.39.2 起，见 desktop/accounts.js）。
 *
 * 在这之前是写死的 `<数据根>/data`——那个路径跟着 macOS 账号走，不跟云端账号走，
 * 于是同一个 macOS 登录下 A 退出、B 登录，B 打开的是同一个库，A 的客户和跟进全看得见。
 *
 * 所以它不再是常量：启动时按指针定下来，换账号时跟着换。`换数据目录()` 是唯一的入口，
 * 因为 cloud.js 记着的 .cloud.json 路径必须跟它一起走。
 */
let 数据目录 = null;
const 日志文件 = path.join(数据根, "logs", "server.log");
/** 应用本身（主进程）没接住的错误。本地服务的输出在 日志文件，两个分开，各看各的 */
const 应用日志 = path.join(数据根, "logs", "app.log");
/**
 * 把数据目录切到 dir：cloud.js 记的 .cloud.json 路径必须跟着一起走，
 * 否则壳会对着上一个账号的令牌判断「登没登录」。
 */
function 换数据目录(dir) {
  数据目录 = dir;
  云端.初始化(dir);
  盯住凭据(dir);
}

/**
 * 盯住 .cloud.json：**换账号这件事由壳自己发现**，页面那一声只是提速。
 *
 * 登录成功时，是本地服务把新令牌写进**当前**这个目录的——而当前这个目录还是上一个人的。
 * 2026-09-20 报的 bug 就在这里：换了账号登录，看到的还是上一个账号的客户。那时换目录
 * 全指望登录页喊一声 shell:switch-account，桥不在时（浏览器里打开的、桥没挂上）
 * 那一声没人接，页面落到 /dashboard，而 /login 见还有令牌又自动登录回来，
 * 于是乙一路进了甲的库，一声不响。一个隔离机制不能挂在页面的配合上。
 *
 * 盯目录而不是盯那个文件：文件可能被删掉再写回来（退出再登录），盯着文件的监视器
 * 会跟着失去目标。代价是同目录里 crm.db 每写一下都会叫一声，所以只认名字以
 * .cloud.json 开头的那几下，再防抖 400ms。
 */
let 凭据监视 = null;
let 凭据防抖 = null;
function 盯住凭据(dir) {
  try {
    凭据监视?.close();
  } catch {
    /* 已经关了 */
  }
  凭据监视 = null;
  try {
    凭据监视 = fs.watch(dir, (_事件, 名字) => {
      if (名字 && !String(名字).startsWith(".cloud.json")) return;
      clearTimeout(凭据防抖);
      凭据防抖 = setTimeout(() => {
        // 这一路上每一步都自己收着错，这个 catch 只是不让它变成未处理的拒绝
        看凭据换没换().catch(() => {});
      }, 400);
    });
  } catch {
    /* 盯不住不致命：启动时那次认领和页面那一声都还在 */
  }
}

/**
 * 把 .cloud.json 从一个目录搬到另一个目录。
 *
 * 换账号那一刻，新令牌是**上一个人的目录里**那个服务写下的。不搬走的话：新目录里
 * 没有令牌，人重起之后又落回登录页；而旧目录里躺着的是别人的令牌——
 * 等于把令牌留在别人家。所以是搬，不是复制。
 *
 * 搬不动不致命（只是要再登一次），但要留个案：这一步失败时的表现是「登录了又回登录页」，
 * 日志里没有记录就只能瞎猜。
 */
function 搬令牌(从, 到) {
  if (从 === 到) return;
  try {
    const 旧文件 = path.join(从, ".cloud.json");
    if (!fs.existsSync(旧文件)) return;
    fs.mkdirSync(到, { recursive: true });
    const 新文件 = path.join(到, ".cloud.json");
    fs.copyFileSync(旧文件, 新文件);
    fs.chmodSync(新文件, 0o600);
    fs.rmSync(旧文件, { force: true });
  } catch (e) {
    崩溃.写崩溃日志(应用日志, "搬令牌失败", e);
  }
}

/** 手上这枚令牌还是这个目录的主人吗。不是就把目录换过去——换账号登录走的就是这条 */
async function 看凭据换没换() {
  // 服务还没起来（启动中）时不插手：那时换目录是 whenReady 里那次认领的事，它不用重起
  if (读配置().mode !== "local" || !本地) return;
  const c = 云端.读();
  // 没登录、或者刚退出登录：目录一个字节都不动（见 accounts.js 的 退出()）
  if (!c?.accountId) return;
  // 未认领的那份（第一次装、升级上来的）没有归属标记，谁登录就归谁，不算换人
  const 归谁 = 账号.归谁(数据目录);
  if (!归谁 || 归谁 === c.accountId) return;
  try {
    await 切账号();
  } catch (e) {
    崩溃.写崩溃日志(应用日志, "换账号失败（壳自己发现的）", e);
  }
}

/*
  升级：把 0.39.2 之前那份单独的 `data/` 认领进 accounts/。只改名，不复制不删除。
  归谁看它自己的 .cloud.json；读不出账号（旧版写的里面没有 accountId）就先放进
  「未认领」，等启动校验那一下从云端问出账号来再认领。**在这儿做，是因为
  这时本地服务还没起来**——目录改名之后，CRM_DATA_DIR 那个字符串就作废了。
*/
try {
  账号.迁移旧数据(数据根, 云端.读账号id);
} catch (e) {
  // 迁不动就按老样子跑（当前目录 会落到未认领），绝不能因为这一步开不了应用
  console.error("[accounts] 迁移旧数据失败：", e?.message ?? e);
}
换数据目录(账号.当前目录(数据根).目录);

/** 随包发布的本地服务。打包后在 Resources/server，开发时在 desktop/server-bundle */
const 服务目录 = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(__dirname, "server-bundle");

/** 旧版本默认指向的托管版地址，只在从旧配置迁移过来时用得上 */
const 默认服务器 = process.env.CRM_URL || "https://app.ai-daedalus.com";

let win = null;
/** 本地服务起来之后的地址与一次性令牌 */
let 本地 = null;
/** 启动那次校验发现令牌被吊销了。只用一次：第一次进门时把原因带上 */
let 启动时被吊销 = false;

function 读配置() {
  // 从旧版本升级上来的：配置还在带空格的老目录里，搬过来
  if (!fs.existsSync(CONFIG_FILE)) {
    const 旧 = path.join(旧数据目录, "config.json");
    if (旧 !== CONFIG_FILE && fs.existsSync(旧)) {
      fs.mkdirSync(数据根, { recursive: true });
      fs.copyFileSync(旧, CONFIG_FILE);
    }
  }
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return {
      // 老配置里没有 mode，但有 serverUrl——那是已经在用托管版的人，
      // 升级后突然切到空空如也的本地库会以为数据没了，所以保持连服务器
      mode: c.mode ?? "server",
      serverUrl: (c.serverUrl || 默认服务器).replace(/\/+$/, ""),
      // 更新相关的两项。以前这里没把它们读回来，于是「跳过这个版本」写进去就丢了，
      // 每次启动照样提示；每天一次的节流也从没生效过
      skipVersion: c.skipVersion,
      lastUpdateCheck: c.lastUpdateCheck,
      // 上次停在哪一页，见 route-memory.js
      lastRoute: c.lastRoute,
    };
  } catch {
    return { mode: "local", serverUrl: 默认服务器 };
  }
}

function 写配置(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

/* ---------- 崩溃与诊断 ---------- */

const 文档地址 = "https://github.com/BeckY824/daedalus-crm/blob/main/docs/桌面端安装.md";
const 反馈地址 = "https://github.com/BeckY824/daedalus-crm/issues/new";

/** 贴进 issue 里的那段。字段少而准：报 bug 时问来问去的就是这几样 */
function 诊断文本() {
  let cfg = {};
  try {
    cfg = 读配置();
  } catch {
    /* 配置坏了也要能出诊断信息 */
  }
  return 崩溃.诊断信息({
    应用: `${APP_NAME} ${app.getVersion()}`,
    系统: `${process.platform} ${os.release()}（${process.arch}）`,
    Electron: process.versions.electron,
    模式: cfg.mode === "server" ? `服务器 ${cfg.serverUrl}` : "本机数据",
    云端账号: 云端.读() ? "已登录" : "未登录",
    数据目录: 数据根,
    应用包: 应用包 || "（开发态）",
  });
}

let 正在报告崩溃 = false;

/**
 * 主进程没接住的错误：先落日志（同步，进程可能马上没了），再弹框。
 * 弹框只弹一个——一个错常常连着一串，叠十个对话框比不弹更糟。
 * app 还没 ready 时弹不了框，只记日志。
 */
function 报告崩溃(标题, e) {
  const 块 = 崩溃.写崩溃日志(应用日志, 标题, e, { 应用: `${APP_NAME} ${app.getVersion()}`, 系统: `${process.platform} ${os.release()}` });
  if (正在报告崩溃 || !app.isReady()) return;
  正在报告崩溃 = true;
  dialog
    .showMessageBox(win && !win.isDestroyed() ? win : null, {
      type: "error",
      title: "应用出错了",
      message: "应用遇到一个没处理的错误",
      detail: `${崩溃.错误文本(e).split("\n").slice(0, 6).join("\n")}\n\n已记到 logs/app.log。可以继续用；反复出现的话请反馈给我们。`,
      buttons: ["复制错误", "打开日志文件夹", "关闭"],
      defaultId: 0,
      cancelId: 2,
    })
    .then(({ response }) => {
      if (response === 0) clipboard.writeText(`${诊断文本()}\n\n${块}`);
      else if (response === 1) shell.showItemInFolder(应用日志);
    })
    .finally(() => {
      正在报告崩溃 = false;
    });
}

process.on("uncaughtException", (e) => 报告崩溃("未捕获的异常", e));
process.on("unhandledRejection", (e) => 报告崩溃("未处理的 Promise 拒绝", e));
// 渲染进程 / GPU 等子进程没了：不弹框（Electron 自己会重建或用户会看到白屏），只记一笔
app.on("render-process-gone", (_e, _wc, d) => 崩溃.写崩溃日志(应用日志, "渲染进程退出", `${d.reason}（${d.exitCode}）`));
app.on("child-process-gone", (_e, d) => 崩溃.写崩溃日志(应用日志, "子进程退出", `${d.type} ${d.name || ""}：${d.reason}（${d.exitCode}）`));

/* ---------- 启动 ---------- */

async function 启动本地() {
  /**
   * AI 配置不再从这里塞环境变量：服务端自己读数据目录里的 .cloud.json（每次都重读），
   * 登录、退出即时生效，不用重启服务。这里只告诉它云端在哪（本机联调时能指到别处）。
   */
  /*
    机器标识（加盐 sha256 的硬件 UUID，见 machine.js）也在这里传进去：
    登录接口要拿它把「注册赠送的 30 次一台机器只发一次」那条规则落下来。
    在壳里算而不是在服务端算——它要跑 ioreg / 读注册表，那是壳该干的事；
    取不到就传空串，服务端据此当「不知道是哪台机器」（不发注册赠送，不是照发）。
    值在同一台机器上不变，所以随环境变量传一次就够，不用做成接口。
  */
  本地 = await 本地服务.start({
    bundleDir: 服务目录,
    dataDir: 数据目录,
    logFile: 日志文件,
    额外环境: { CRM_CLOUD_URL: 云端.默认云端, CRM_MACHINE_HASH: 机器.机器哈希() ?? "" },
  });
  /*
    MCP 的固定端口。本地服务每次换一个随机端口，而别人的 agent（Claude Code / Codex）
    那边配的是一行写死的地址——所以在一个固定端口上开一条只转 /api/mcp 的薄桥。
    取端口现问不缓存：重启本地服务会换端口，这座桥要跨过那次重启。
    开不起来（端口全被占）就不开，其余功能照常——MCP 是附加能力，不该挡着人用 CRM。
  */
  const p = await MCP桥.start({ 取端口: () => 本地?.port ?? null, dataDir: 数据目录 });
  if (!p) console.warn("[mcp] 固定端口没开起来，MCP 只能按本次的随机端口连");
}

/** 本地模式的首页：带令牌换一张会话票据，换完自己跳去 /dashboard；没登录云端账号时它会落到 /login */
function 本地入口() {
  // 启动时发现令牌被吊销了：把原因带上，登录页那句话据此说清（见 api/desktop/session）
  const reason = 启动时被吊销 ? "&reason=revoked" : "";
  启动时被吊销 = false;
  // 回到上次停的那一页（route-memory.js 记的）；session 路由那边还会再验一遍
  const 上次 = 读配置().lastRoute;
  const next = 上次 ? `&next=${encodeURIComponent(上次)}` : "";
  return `http://127.0.0.1:${本地.port}/api/desktop/session?t=${本地.token}${reason}${next}`;
}

/** 当前窗口里那个站的根地址：本地服务或所连的服务器。菜单「前往」和「设置…」按它拼路径 */
function 当前根() {
  const cfg = 读配置();
  return cfg.mode === "local" ? `http://127.0.0.1:${本地?.port}` : cfg.serverUrl;
}

function 前往(路径) {
  if (!win || win.isDestroyed()) return 建窗口();
  win.loadURL(`${当前根()}${路径}`);
}

/**
 * 菜单里的「设置」走这条：**让页面自己 push 过去**。
 * 应用里点设置弹的是一层浮层（Next 的拦截路由），而拦截只认软导航——
 * 壳这边 loadURL 的话，同一个「设置」从菜单进是整页、从账号菜单进是浮层，
 * 同一个标签两种样子。
 *
 * 对面可能没人接：登录页还没挂上应用的壳，服务器模式下连的托管站也可能比这个壳旧。
 * 所以等一声 nav:ok，400ms 内没等到就退回硬跳转——那条路永远走得通。
 */
function 去(路径) {
  if (!win || win.isDestroyed()) return 建窗口();
  let 应答了 = false;
  const 收 = () => {
    应答了 = true;
  };
  ipcMain.once("nav:ok", 收);
  win.webContents.send("nav:go", 路径);
  setTimeout(() => {
    ipcMain.removeListener("nav:ok", 收);
    if (!应答了) 前往(路径);
  }, 400);
}

function 当前地址() {
  const cfg = 读配置();
  return cfg.mode === "local" ? 本地入口() : `${cfg.serverUrl}${cfg.lastRoute ?? ""}`;
}

function 建窗口() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: APP_NAME,
    /**
     * 不画系统标题栏：标题「Daedalus CRM」在侧栏已经有一个标了，标题栏上再写一遍是重复。
     * 红黄绿钮嵌进页面左上（侧栏顶部留了 44px），那一块和中栏头、页头的 CSS 都标了
     * -webkit-app-region: drag，窗口照样拖得动——页面是服务端渲染的也不妨碍这条 CSS 生效。
     * 壳靠 UA 里的 "Electron/" 判断自己在桌面端里，见 (app)/layout.tsx。
     */
    ...(process.platform === "darwin" ? {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 20, y: 16 },
    } : {}),
    backgroundColor: "#fafafa",
    show: false,
    icon: path.join(__dirname, "assets/icon.png"),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload-app.js") },
  });

  win.once("ready-to-show", () => win.show());
  win.loadURL(当前地址());

  // 记住停在哪一页：重启（包括更新后的那次）回到原地，不再每次都从首页开始
  const 记路径 = (_e, url) => {
    const p = 路径记忆.可恢复的路径(url, 当前根());
    if (p && p !== 读配置().lastRoute) 写配置({ ...读配置(), lastRoute: p });
  };
  win.webContents.on("did-navigate", 记路径);
  win.webContents.on("did-navigate-in-page", 记路径);

  // 站外链接交给系统浏览器，免得用户在没有地址栏的窗口里迷路
  win.webContents.setWindowOpenHandler(({ url }) => {
    const 自己 = 读配置().mode === "local" ? `http://127.0.0.1:${本地?.port}` : 读配置().serverUrl;
    if (!url.startsWith(自己)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  win.webContents.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 是主动取消（自己发起的跳转打断了上一次加载），不是错误
    if (code === -3) return;
    const cfg = 读配置();
    if (cfg.mode === "local") {
      报告本地故障(`${desc}（${code}）`);
      return;
    }
    dialog
      .showMessageBox(win, {
        type: "warning",
        title: "连不上服务器",
        message: `连接 ${cfg.serverUrl} 失败`,
        detail: `${desc}（${code}）\n\n检查一下网络，或确认服务器地址填对了。`,
        buttons: ["重试", "改服务器地址", "改用本地数据", "退出"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) win.loadURL(cfg.serverUrl);
        else if (response === 1) 问服务器地址();
        else if (response === 2) 切到本地();
        else app.quit();
      });
  });
}

function 报告本地故障(原因) {
  dialog
    .showMessageBox(win ?? null, {
      type: "error",
      title: "本地服务没能启动",
      message: "本机的 CRM 服务没能起来",
      detail: `${原因}\n\n最后几行日志：\n${本地服务.日志尾巴() || "（没有输出）"}`,
      buttons: ["查看完整日志", "改用服务器", "退出"],
      defaultId: 0,
    })
    .then(({ response }) => {
      if (response === 0) shell.showItemInFolder(日志文件);
      else if (response === 1) 问服务器地址();
      else app.quit();
    });
}

/* ---------- 模式切换 ---------- */

async function 切到本地() {
  // 远端的路径可能在本机不存在，不能把远端最后一页带进本地服务。
  写配置({ ...读配置(), mode: "local", lastRoute: "/dashboard" });
  // 没登录云端账号也照开：本地服务的 /login 就是云端账号的门，壳不用再拦一道
  try {
    if (!本地服务.运行中()) await 启动本地();
    win ? win.loadURL(本地入口()) : 建窗口();
  } catch (e) {
    报告本地故障(e?.message ?? String(e));
  }
  建菜单();
}

function 问服务器地址() {
  const cur = 读配置().serverUrl;
  // Electron 没有内置输入框，用一个极简页面代替
  const input = new BrowserWindow({
    width: 480,
    height: 250,
    resizable: false,
    title: "服务器地址",
    parent: win ?? undefined,
    modal: Boolean(win),
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  input.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`
    <body style="font:14px -apple-system,'PingFang SC','Microsoft YaHei';padding:22px;margin:0;background:#fafafa">
      <div style="font-weight:600;margin-bottom:10px">服务器地址</div>
      <input id="u" value="${cur}" style="width:100%;padding:9px 11px;font-size:14px;
        border:1px solid #d9dee7;border-radius:7px;box-sizing:border-box">
      <div style="margin-top:8px;color:#6b7280;font-size:12px">
        填你们自己部署的那台机器的地址。团队共用一份数据时用这个模式。
      </div>
      <div style="margin-top:20px;text-align:right">
        <button onclick="window.close()" style="padding:7px 16px;margin-right:8px">取消</button>
        <button onclick="crm.save(document.getElementById('u').value)"
          style="padding:7px 16px;background:#2f6bff;color:#fff;border:none;border-radius:6px">连接</button>
      </div>
    </body>`),
  );
  input.webContents.once("ipc-message", (_e, ch, url) => {
    if (ch !== "save-url") return;
    const clean = String(url).trim().replace(/\/+$/, "");
    // 只认 http(s)：填错协议会让窗口白屏，且看不出是为什么
    if (!/^https?:\/\/.+/.test(clean)) return;
    写配置({ mode: "server", serverUrl: clean });
    input.close();
    // 本地服务留着不停：切回来时不用再等一次冷启动
    win ? win.loadURL(clean) : 建窗口();
    建菜单();
  });
}

/* ---------- 云端账号 ---------- */

/**
 * 令牌在服务端被吊销了：改了密码（该账号**每一台**机器都退出），或者在网页设置页的
 * 「已登录的机器」里单独退了这一台。分不出是哪一条——服务端两种都只回 401，
 * 区分开就成了令牌探测接口。cloud.js 的 校验() 已经把本地那枚清掉了，
 * 这里只负责把人送回门口，原因由登录页那句话说（?reason=revoked）。
 * **不弹系统对话框**：不是用户在这台机器上主动退的，弹一个「要退出吗」只会让人以为还有得选。
 */
function 令牌失效了() {
  if (读配置().mode !== "local") return;
  // 经 logout 走：业务会话 cookie 还活着，直接去 /login 会被弹回首页
  前往("/api/auth/logout?reason=revoked");
}

/* ---------- 检查更新 ---------- */

/** 应用包的路径（…/Daedalus CRM.app）。开发态 `electron .` 时是 null */
const 应用包 = 安装.解析应用包(process.execPath);

/**
 * 更新是「后台查、查到了给个按钮、点了才下、下完再给个按钮」的模式，**不弹对话框**。
 * 状态推给页面，页面在侧栏画按钮：先是「更新到 x · 差量 2.3 MB」，点了开始下载；
 * 下完变成「重启以更新」，点了才停服务、换包、重启。（0.24.0 是查到就自动下，用户说该先问再下）
 *
 * 阶段：idle → checking → available（等按钮）→ downloading（进度）→ ready（等按钮）→ installing
 *       或 manual（不能原地换：给下载页）   或 error（按钮变成「重试」，点了接着下）
 *
 * 换包本身在 install.js；不经 Squirrel.Mac，所以 ad-hoc 签名不是障碍。
 */
let 更新状态 = { 阶段: "idle" };
/** 查到新版后算好的方案：差量（清单 + 比对结果）还是整包。点按钮时照它下 */
let 计划 = null;
let 待装 = null;
let 正在查 = false;

function 设更新状态(s) {
  更新状态 = s;
  if (win && !win.isDestroyed()) win.webContents.send("update:state", 更新状态);
}

/** 只查、只估算，**不下**。手动点菜单时 手动=true：已是最新要给句回话，其余情况都静默 */
async function 检查更新({ 手动 = false } = {}) {
  if (正在查) return;
  /*
    差量包**自动下**。0.24.0 那次「先问再下」的理由是 160 MB 整包：自动下会把人的网占满，
    断了还从头来。差量之后典型 2–6 MB、支持续传，那个理由不在了；整包仍然要人点。
    下完不装：装等人点「重启」，或者退出时顺手换上（见 before-quit）。
  */
  let 自动下 = false;
  if (更新状态.阶段 === "available") {
    if (手动) dialog.showMessageBox(win ?? null, { type: "info", title: "检查更新", message: `有新版本 ${更新状态.版本}`, detail: "这一版是整包，侧栏底部有按钮，点了才开始下载。" });
    return;
  }
  if (更新状态.阶段 === "downloading" || 更新状态.阶段 === "ready" || 更新状态.阶段 === "installing") {
    if (手动) dialog.showMessageBox(win ?? null, { type: "info", title: "检查更新", message: `${更新状态.版本} 已在准备中`, detail: "下载完成后侧栏会出现「重启」按钮；不点的话，退出时会自动换上，下次打开就是新版。" });
    return;
  }
  正在查 = true;
  try {
    写配置({ ...读配置(), lastUpdateCheck: new Date().toISOString() });
    设更新状态({ 阶段: "checking" });
    const 新版 = await 更新.检查({ 当前版本: app.getVersion(), platform: process.platform, arch: process.arch });
    if (!新版) {
      设更新状态({ 阶段: "idle" });
      if (手动) dialog.showMessageBox(win ?? null, { type: "info", title: "检查更新", message: "已经是最新版本", detail: `当前版本 ${app.getVersion()}。` });
      return;
    }
    const 版本 = String(新版.版本).replace(/^v/, "");
    const 可原地 = process.platform === "win32"
      ? { ok: app.isPackaged && !!新版.exe && /^[a-f0-9]{64}$/i.test(新版.sha256 || ""), 原因: "这一版没有提供可校验的 Windows 安装包" }
      : 新版.dmg ? 安装.能原地更新(应用包) : { ok: false, 原因: "这一版没有提供直接下载地址" };
    if (!可原地.ok) {
      设更新状态({ 阶段: "manual", 版本, 地址: 新版.地址, 原因: 可原地.原因 });
      return;
    }
    计划 = { 版本, 新版, 方式: "整包", 文字: 新版.体积 ? `整包 ${新版.体积}` : "整包" };
    /**
     * 先估算差量：只拉清单（100 多 KB）和已装的包比对，不下 zip。算出来划算，按钮上就写
     * 「差量 2.3 MB」；任何不划算或对不上的情况（老 Release 没有清单、变得太多、包名不对…）
     * 都退回整包，按钮上写整包的体积。见 delta.js 顶部。
     */
    if (process.platform === "darwin" && 新版.zip && 新版.manifest) {
      try {
        设更新状态({ 阶段: "checking", 文字: "正在比对已装的文件…" });
        const 估 = await 差量.差量估算({
          清单Url: 新版.manifest,
          已装: 应用包,
          缓存路径: path.join(数据根, "updates", "hash-cache.json"),
          日志: (行) => 崩溃.写崩溃日志(应用日志, "差量估算", 行),
        });
        计划 = { ...计划, 方式: "差量", 清单: 估.清单, 比对结果: 估.比对结果, 文字: `差量 ${(估.要下 / 1048576).toFixed(1)} MB` };
      } catch (e) {
        崩溃.写崩溃日志(应用日志, e?.name === "退回整包" ? "差量退回整包" : "差量估算失败，退回整包", e);
      }
    }
    设更新状态({ 阶段: "available", 版本, 说明: 新版.说明, 文字: 计划.文字 });
    自动下 = 计划.方式 === "差量";
  } catch (e) {
    崩溃.写崩溃日志(应用日志, "检查更新失败", e);
    设更新状态({ 阶段: "error", 错误: String(e?.message ?? e) });
  } finally {
    正在查 = false;
  }
  if (自动下) await 下载更新();
}

/**
 * 点了「更新到 x」：按 计划 下载。差量就组装 X.app.new，整包就下 dmg；下完进 ready。
 * 差量中途不行退回整包；整包断了 install.js 自己续传重试，还不行进 error，
 * 「重试」按钮再进这里——.part 还在，接着下。
 */
async function 下载更新() {
  if (更新状态.阶段 !== "available" && 更新状态.阶段 !== "error") return;
  if (!计划) return 检查更新({ 手动: true });
  if (正在查) return;
  正在查 = true;
  const { 版本, 新版 } = 计划;
  try {
    if (计划.方式 === "差量") {
      try {
        设更新状态({ 阶段: "downloading", 版本, 进度: 0, 文字: 计划.文字 });
        const { 统计 } = await 差量.差量组装({
          清单: 计划.清单,
          比对结果: 计划.比对结果,
          zipUrl: 新版.zip,
          已装: 应用包,
          进度: (已, 总) => 设更新状态({ 阶段: "downloading", 版本, 进度: 总 ? Math.round((已 / 总) * 100) : null, 文字: `差量更新 ${(总 / 1048576).toFixed(1)} MB` }),
          日志: (行) => 崩溃.写崩溃日志(应用日志, "差量更新", 行),
        });
        待装 = { 版本, 方式: "差量", 地址: 新版.地址 };
        设更新状态({ 阶段: "ready", 版本, 说明: 新版.说明, 文字: `差量 ${(统计.字节 / 1048576).toFixed(1)} MB，复用 ${统计.复用} 个文件` });
        return;
      } catch (e) {
        // 退回整包不算错，记一笔就好；别的错也一样退，但记全
        崩溃.写崩溃日志(应用日志, e?.name === "退回整包" ? "差量退回整包" : "差量失败，退回整包", e);
        await 安装.删目录(`${应用包}.new`).catch(() => {});
        计划 = { ...计划, 方式: "整包", 文字: 新版.体积 ? `整包 ${新版.体积}` : "整包" };
      }
    }
    const 文件 = path.join(数据根, "updates", `Daedalus-CRM-${版本.replace(/[^a-zA-Z0-9.-]/g, "_")}.${process.platform === "win32" ? "exe" : "dmg"}`);
    设更新状态({ 阶段: "downloading", 版本, 进度: 0, 文字: "整包下载" });
    await 安装.下载文件({
      url: process.platform === "win32" ? 新版.exe : 新版.dmg,
      // 上面那个地址可能是我们自己的镜像；下不动就换 GitHub 原址从头来
      备用: 新版.备用?.[process.platform === "win32" ? "exe" : "dmg"] || null,
      目标: 文件,
      sha256: 新版.sha256,
      日志: (行) => 崩溃.写崩溃日志(应用日志, "整包下载", 行),
      进度: (已, 总) => 设更新状态({ 阶段: "downloading", 版本, 进度: 总 ? Math.round((已 / 总) * 100) : null, 文字: `整包下载 ${(总 / 1048576).toFixed(0)} MB` }),
    });
    if (新版.sha256) await 安装.校验sha256(文件, 新版.sha256);
    待装 = { 版本, 方式: "整包", 文件, 地址: 新版.地址, sha256: 新版.sha256 };
    设更新状态({ 阶段: "ready", 版本, 说明: 新版.说明 });
  } catch (e) {
    崩溃.写崩溃日志(应用日志, "下载更新失败", e);
    设更新状态({ 阶段: "error", 版本, 错误: String(e?.message ?? e) });
  } finally {
    正在查 = false;
  }
}

/**
 * 点了按钮：停本地服务 → 换包 → 重启。
 * 换包前失败什么都没动；换包失败会退回旧包；服务停了但没换成，就把服务再拉起来。
 */
async function 安装更新() {
  if (!待装 || 更新状态.阶段 !== "ready") return;
  const { 版本, 方式, 文件, 地址 } = 待装;
  设更新状态({ 阶段: "installing", 版本 });
  let 服务停过 = false;
  try {
    if (本地服务.运行中()) {
      服务停过 = true;
      await 本地服务.stop();
    }
    if (process.platform === "win32") {
      await require("./windows-install").启动安装({ 文件, sha256: 待装.sha256 });
      待装 = null;
      app.quit();
      return;
    }
    // 差量：X.app.new 已经组装好、验过签，只剩把它换到原位。整包：挂 dmg、复制、换包
    if (方式 === "差量") await 安装.换包(应用包);
    else await 安装.安装dmg({ dmg: 文件, 目标: 应用包 });
    if (文件) await fs.promises.rm(文件, { force: true }).catch(() => {});
    app.relaunch();
    app.exit(0);
  } catch (e) {
    崩溃.写崩溃日志(应用日志, "安装更新失败", e);
    if (文件) await fs.promises.rm(文件, { force: true }).catch(() => {});
    await 安装.删目录(`${应用包}.new`).catch(() => {});
    待装 = null;
    if (服务停过 && 读配置().mode === "local") {
      try {
        await 启动本地();
        if (win) win.loadURL(本地入口());
      } catch {
        /* 页面上的按钮已经在说失败了 */
      }
    }
    设更新状态({ 阶段: "error", 错误: String(e?.message ?? e), 地址 });
  }
}

ipcMain.handle("update:state", () => 更新状态);
ipcMain.handle("update:download", () => 下载更新());
ipcMain.handle("update:install", () => 安装更新());
ipcMain.handle("update:check", () => 检查更新({ 手动: true }));
// 只开主进程自己状态里的地址，页面传不进任何 URL
ipcMain.handle("update:open", () => {
  if (更新状态.地址) shell.openExternal(更新状态.地址);
});

/* ---------- 菜单 ---------- */

/**
 * 备份数据库：让用户挑位置，用 SQLite 的在线备份拷一份，再验一遍。
 * 由设置页「桌面端」那一栏经 desktopShell.backup() 调；结果回给页面，页面自己说。
 */
async function 备份数据库() {
  const 源 = path.join(数据目录, "crm.db");
  if (!fs.existsSync(源)) return { ok: false, error: "还没有本机数据库：本机模式第一次启动后才会建库" };
  const { canceled, filePath } = await dialog.showSaveDialog(win ?? null, {
    title: "备份数据库",
    defaultPath: path.join(app.getPath("desktop"), 备份.建议文件名()),
    filters: [{ name: "SQLite 数据库", extensions: ["db"] }],
  });
  if (canceled || !filePath) return { ok: false };
  try {
    await 备份.备份数据库(源, filePath);
    shell.showItemInFolder(filePath);
    return { ok: true, 文件: path.basename(filePath) };
  } catch (e) {
    崩溃.写崩溃日志(应用日志, "备份失败", e);
    return { ok: false, error: `没能完成备份：${e?.message ?? e}` };
  }
}

/* ---------- 壳给页面的口子（设置页「桌面端」那一栏） ---------- */

/**
 * 跑完了叫人一声。
 *
 * AI 问一句要十几秒，人不会盯着看——他会切去别的应用。侧栏那条进度只在窗口里有用，
 * 人不看着它就等于没有。所以答完了发一条系统通知，点一下把窗口叫到前面。
 *
 * **在不在前台由壳判断，不由页面判断。** 页面那边只管「这一条答完了」，
 * 前台与否是壳的事（页面的 document.hasFocus 分不清「窗口在前台但被别的窗口盖住」
 * 这类情况，也不该让两处各判一遍——两处迟早不一致）。窗口在前台就不弹：
 * 侧栏那一条已经说了，再弹一个系统通知是吵。
 *
 * 页面能传进来的只有两段字，别的一概没有：弹什么、点了干什么都在这儿定死。
 */
ipcMain.handle("notify:show", (_e, 内容) => {
  if (!Notification.isSupported()) return { ok: false, 原因: "不支持" };
  if (win && !win.isDestroyed() && win.isFocused()) return { ok: false, 原因: "在前台" };
  const 截 = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const title = 截(内容?.标题, 60);
  if (!title) return { ok: false, 原因: "没内容" };
  const n = new Notification({ title, body: 截(内容?.正文, 160) });
  n.on("click", () => {
    if (!win || win.isDestroyed()) return 建窗口();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  n.show();
  return { ok: true };
});

ipcMain.handle("shell:version", () => app.getVersion());
ipcMain.handle("shell:backup", () => 备份数据库());
ipcMain.handle("shell:open-data", () => shell.openPath(数据目录));
/**
 * 换了个云端账号登录：把数据目录切过去，重起本地服务，窗口重载。
 *
 * **换成谁不由页面说**——页面只喊一声「换了」，换成谁由这里自己去读
 * 刚写下的 .cloud.json。preload 那座桥的规矩就是页面传不进参数，
 * 页面被换掉也做不了别的（见 preload-app.js 开头）。
 *
 * **而且这一声只是提速，不是机制**：页面喊不出来（桥不在）时壳自己也会发现，
 * 见上面的 盯住凭据()。两条路进同一个 切账号()，同一时刻只切一次。
 *
 * 非重起不可：`DATABASE_URL` 和 `CRM_DATA_DIR` 都是子进程启动时烤进去的，
 * 不重起就还连着上一个人的库。登录那头已经先一步收住了，换账号时
 * 一个字都没往上一个人的库里写（见 login/actions.ts 的 桌面端登录）。
 */
ipcMain.handle("shell:switch-account", () => 切账号());

let 切换中 = null;
function 切账号() {
  if (!切换中) {
    切换中 = 切一次().finally(() => {
      切换中 = null;
    });
  }
  return 切换中;
}

async function 切一次() {
  const c = 云端.读();
  if (!c?.accountId) return { ok: false, error: "还没登录" };
  // Windows 不允许移动仍被 SQLite/目录监视器占用的目录。
  // 先停服务再认领，账号切换失败时恢复原目录的服务。
  const 先停 = process.platform === "win32" && 本地服务.运行中();
  if (先停) {
    凭据监视?.close();
    await 本地服务.stop();
  }
  let 目标;
  try {
    目标 = 账号.认领(数据根, c.accountId);
  } catch (e) {
    if (先停) {
      盯住凭据(数据目录);
      await 启动本地().catch((err) => 报告本地故障(String(err)));
    }
    崩溃.写崩溃日志(应用日志, "换账号失败", e);
    return { ok: false, error: "换不了数据目录" };
  }
  if (目标.换了目录 || 先停) {
    搬令牌(数据目录, 目标.目录);
    换数据目录(目标.目录);
    await 本地服务.stop();
    try {
      await 启动本地();
    } catch (e) {
      报告本地故障(e?.message ?? String(e));
      return { ok: false, error: "本地服务起不来" };
    }
  }
  win?.loadURL(本地入口());
  return { ok: true };
}
ipcMain.handle("shell:open-logs", () => shell.showItemInFolder(日志文件));
ipcMain.handle("shell:diagnostics", () => 诊断文本());
ipcMain.handle("shell:use-server", (_e, url) => {
  const clean = String(url ?? "").trim().replace(/\/+$/, "");
  // 只认 http(s)：填错协议会让窗口白屏，且看不出是为什么
  if (!/^https?:\/\/.+/.test(clean)) return { ok: false, error: "地址要以 http:// 或 https:// 开头" };
  写配置({ mode: "server", serverUrl: clean });
  // 本地服务留着不停：切回来时不用再等一次冷启动
  win ? win.loadURL(clean) : 建窗口();
  建菜单();
  return { ok: true };
});

function 建菜单() {
  const cfg = 读配置();
  const isMac = process.platform === "darwin";
  /**
   * 照 Claude 桌面端那套：应用 / 文件 / 编辑 / 显示 / 前往 / 窗口 / 帮助，全是标准项。
   * 账号、备份、日志、诊断一条都不进菜单——它们在设置页「桌面端」那一栏。
   * 唯一的例外是服务器模式下的「改用本机数据」：那时窗口里是别人的站，
   * 它的设置页没有「桌面端」这一栏，切回来只能从壳这里走。
   */
  const 应用菜单 = {
    label: APP_NAME,
    submenu: [
      { role: "about", label: `关于 ${APP_NAME}` },
      { type: "separator" },
      { label: "设置…", accelerator: "CmdOrCtrl+,", click: () => 去(cfg.mode === "local" ? "/settings?tab=desktop" : "/settings") },
      ...(cfg.mode === "server" ? [{ type: "separator" }, { label: `改用本机数据（现在连着 ${cfg.serverUrl}）`, click: () => 切到本地() }] : []),
      { type: "separator" },
      ...(isMac ? [{ role: "hide", label: `隐藏 ${APP_NAME}` }, { role: "hideOthers", label: "隐藏其他" }, { role: "unhide", label: "全部显示" }, { type: "separator" }] : []),
      { role: "quit", label: `退出 ${APP_NAME}` },
    ],
  };
  // 左栏那几项，路径和 AppShell 里的一致。⌘N 不在这里：页面自己接了（新建当前页的那个东西）
  const 前往项 = [
    ["首页", "/dashboard"],
    ["数据", "/overview"],
    ["线索", "/leads"],
    ["学员", "/customers"],
    ["渠道", "/channels"],
    ["联系人", "/contacts"],
    ["商机", "/opportunities"],
    ["跟进", "/follow-ups"],
    ["报表", "/reports"],
  ].map(([label, 路径], i) => ({ label, accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined, click: () => 前往(路径) }));

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      应用菜单,
      {
        label: "文件",
        submenu: [{ role: "close", label: "关闭窗口" }],
      },
      {
        label: "编辑",
        submenu: [
          { role: "undo", label: "撤销" },
          { role: "redo", label: "重做" },
          { type: "separator" },
          { role: "cut", label: "剪切" },
          { role: "copy", label: "复制" },
          { role: "paste", label: "粘贴" },
          { role: "selectAll", label: "全选" },
        ],
      },
      {
        label: "显示",
        submenu: [
          { role: "reload", label: "重新加载" },
          { type: "separator" },
          { role: "resetZoom", label: "实际大小" },
          { role: "zoomIn", label: "放大" },
          { role: "zoomOut", label: "缩小" },
          { type: "separator" },
          { role: "togglefullscreen", label: "全屏" },
        ],
      },
      {
        label: "前往",
        submenu: [...前往项, { type: "separator" }, { label: "设置", click: () => 去("/settings") }],
      },
      {
        label: "窗口",
        role: "window",
        submenu: [
          { role: "minimize", label: "最小化" },
          { role: "zoom", label: "缩放" },
          ...(isMac ? [{ type: "separator" }, { role: "front", label: "前置全部窗口" }] : []),
        ],
      },
      {
        label: "帮助",
        role: "help",
        submenu: [
          { label: "使用文档", click: () => shell.openExternal(文档地址) },
          {
            label: "反馈问题…",
            click: () => shell.openExternal(`${反馈地址}?body=${encodeURIComponent(`（描述一下遇到的问题，最好带上操作步骤）\n\n---\n${诊断文本()}`)}`),
          },
        ],
      },
    ]),
  );
}

/* ---------- 生命周期 ---------- */

// 单实例：重复点图标时聚焦已开的窗口，而不是开第二个（第二个还会去抢端口）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    建菜单();
    安装.清理旧包(应用包).catch(() => {});
    if (读配置().mode === "local") {
      /*
        先问一句手上这枚令牌还认不认。改密码会把设备令牌全部吊销（2026-09-17），
        本地存着一枚不代表还能用——不问的话应用照常开着，只有 AI 在背后一路 401。
        问不到（断网）当作还认，见 cloud.js 的 校验()。
      */
      if (云端.读()) {
        const r = await 云端.校验();
        启动时被吊销 = r.原因 === "已吊销";
        /*
          认领这份数据。**必须赶在本地服务起来之前**——认领可能是一次目录改名
          （升级上来的那份、或者第一次装应用时建在「未认领」里的那份），
          而 CRM_DATA_DIR 是启动时就烤进子进程环境的一个字符串，改完名它就作废了。
          启动这一刻服务还没起，是唯一不用重启就能换目录的时机。
        */
        if (r.accountId) {
          try {
            const 目标 = 账号.认领(数据根, r.accountId);
            /*
              上一回运行时在别人的目录上换过账号（页面那一声没人接、壳是老版本），
              令牌就还躺在上一个人的目录里。这一步把它带到它自己的目录去——
              不搬的话新主人打开应用还要再登一次，而别人的目录里留着他的令牌。
            */
            if (目标.换了目录) 搬令牌(数据目录, 目标.目录);
            换数据目录(目标.目录);
          } catch (e) {
            console.error("[accounts] 认领失败，先按当前目录跑：", e?.message ?? e);
          }
        }
      }
      // 没登录也照起：本地服务的 /login 就是云端账号的门
      try {
        await 启动本地();
      } catch (e) {
        报告本地故障(e?.message ?? String(e));
        return;
      }
    }
    建窗口();
    // 开机就查会和冷启动抢资源，等一会儿再说；之后每 6 小时再查一次。都是静默的，有新版就后台下
    setTimeout(() => 检查更新().catch(() => {}), 15_000);
    setInterval(() => 检查更新().catch(() => {}), 6 * 60 * 60 * 1000);
    // 切回应用时也查一次。6 小时的定时器只是兜底——2026-09-16 官网发了新版，
    // 用户开着的应用要等 6 小时才知道，只好去点菜单。10 分钟内不重复，免得来回切窗口刷请求；
    // 初值设成现在，是让启动那一下的 focus 不要和 15 秒后那次撞在一起
    let 上次焦点查 = Date.now();
    app.on("browser-window-focus", () => {
      if (Date.now() - 上次焦点查 < 10 * 60 * 1000) return;
      上次焦点查 = Date.now();
      检查更新().catch(() => {});
    });
    /*
      切回应用时校验令牌。**这条比启动时那次更要紧**：在网页上改完密码的人
      下一个动作就是切回应用，而不是重启它。节流 30 秒，够挡住来回切窗口，
      又不至于让人对着一个已经失效的账号用上半天。
    */
    let 上次校验 = Date.now();
    app.on("browser-window-focus", async () => {
      if (读配置().mode !== "local" || Date.now() - 上次校验 < 30_000 || !云端.读()) return;
      上次校验 = Date.now();
      const r = await 云端.校验().catch(() => ({ 有效: true }));
      if (!r.有效) 令牌失效了();
    });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) 建窗口();
    });
  });

  // 退出前把本地服务收掉，别留一个孤儿进程占着端口和数据库
  app.on("before-quit", () => {
    本地服务.stop();
    MCP桥.stop();
    /*
      下好的差量包在退出时顺手换上（Claude Code 的做法）：下次打开就是新版，
      多数人根本不用见到那个「重启」键。只做差量——.app.new 早已拼好、验过签，
      换包就是两次 rename；整包要挂 dmg、复制、校验，进程正在退，做不完。
    */
    if (待装?.方式 === "差量" && 更新状态.阶段 === "ready") {
      try {
        安装.换包同步(应用包);
        崩溃.写崩溃日志(应用日志, "退出时换包", `${待装.版本} 已换上，下次启动生效`);
      } catch (e) {
        崩溃.写崩溃日志(应用日志, "退出时换包失败", e);
      }
    }
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
