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
const { app, BrowserWindow, shell, dialog, Menu, clipboard, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const 本地服务 = require("./local-server");
const 云端 = require("./cloud");
const 更新 = require("./updater");
const 安装 = require("./install");
const 差量 = require("./delta");
const 备份 = require("./backup");
const 崩溃 = require("./crashlog");
const os = require("node:os");

const APP_NAME = "Daedalus CRM";

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
const 数据目录 = path.join(数据根, "data");
const 日志文件 = path.join(数据根, "logs", "server.log");
/** 应用本身（主进程）没接住的错误。本地服务的输出在 日志文件，两个分开，各看各的 */
const 应用日志 = path.join(数据根, "logs", "app.log");
云端.初始化(数据目录);

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
  本地 = await 本地服务.start({
    bundleDir: 服务目录,
    dataDir: 数据目录,
    logFile: 日志文件,
    额外环境: { CRM_CLOUD_URL: 云端.默认云端 },
  });
}

/** 本地模式的首页：带令牌换一张会话票据，换完自己跳去 /dashboard；没登录云端账号时它会落到 /login */
function 本地入口() {
  // 启动时发现令牌被吊销了：把原因带上，登录页那句话据此说清（见 api/desktop/session）
  const reason = 启动时被吊销 ? "&reason=revoked" : "";
  启动时被吊销 = false;
  return `http://127.0.0.1:${本地.port}/api/desktop/session?t=${本地.token}${reason}`;
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
  return cfg.mode === "local" ? 本地入口() : cfg.serverUrl;
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
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 16 },
    backgroundColor: "#fafafa",
    show: false,
    icon: path.join(__dirname, "assets/icon.png"),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload-app.js") },
  });

  win.once("ready-to-show", () => win.show());
  win.loadURL(当前地址());

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
  写配置({ ...读配置(), mode: "local" });
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
  if (更新状态.阶段 === "available") {
    if (手动) dialog.showMessageBox(win ?? null, { type: "info", title: "检查更新", message: `有新版本 ${更新状态.版本}`, detail: "侧栏底部有按钮，点了才开始下载。" });
    return;
  }
  if (更新状态.阶段 === "downloading" || 更新状态.阶段 === "ready" || 更新状态.阶段 === "installing") {
    if (手动) dialog.showMessageBox(win ?? null, { type: "info", title: "检查更新", message: `${更新状态.版本} 已在准备中`, detail: "下载完成后侧栏会出现「重启以更新」按钮。" });
    return;
  }
  正在查 = true;
  try {
    写配置({ ...读配置(), lastUpdateCheck: new Date().toISOString() });
    设更新状态({ 阶段: "checking" });
    const 新版 = await 更新.检查({ 当前版本: app.getVersion() });
    if (!新版) {
      设更新状态({ 阶段: "idle" });
      if (手动) dialog.showMessageBox(win ?? null, { type: "info", title: "检查更新", message: "已经是最新版本", detail: `当前版本 ${app.getVersion()}。` });
      return;
    }
    const 版本 = String(新版.版本).replace(/^v/, "");
    const 可原地 = 新版.dmg ? 安装.能原地更新(应用包) : { ok: false, 原因: "这一版没有提供直接下载地址" };
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
    if (新版.zip && 新版.manifest) {
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
  } catch (e) {
    崩溃.写崩溃日志(应用日志, "检查更新失败", e);
    设更新状态({ 阶段: "error", 错误: String(e?.message ?? e) });
  } finally {
    正在查 = false;
  }
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
    const 文件 = path.join(数据根, "updates", `Daedalus-CRM-${版本}.dmg`);
    设更新状态({ 阶段: "downloading", 版本, 进度: 0, 文字: "整包下载" });
    await 安装.下载文件({
      url: 新版.dmg,
      目标: 文件,
      sha256: 新版.sha256,
      进度: (已, 总) => 设更新状态({ 阶段: "downloading", 版本, 进度: 总 ? Math.round((已 / 总) * 100) : null, 文字: `整包下载 ${(总 / 1048576).toFixed(0)} MB` }),
    });
    if (新版.sha256) await 安装.校验sha256(文件, 新版.sha256);
    待装 = { 版本, 方式: "整包", 文件, 地址: 新版.地址 };
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

ipcMain.handle("shell:version", () => app.getVersion());
ipcMain.handle("shell:backup", () => 备份数据库());
ipcMain.handle("shell:open-data", () => shell.openPath(数据目录));
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
      if (云端.读()) 启动时被吊销 = (await 云端.校验()).原因 === "已吊销";
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
  app.on("before-quit", () => 本地服务.stop());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
