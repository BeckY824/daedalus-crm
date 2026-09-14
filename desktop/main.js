/**
 * Daedalus CRM 桌面客户端。
 *
 * 两种模式，同一个安装包：
 *   本地   —— 数据和服务都在这台机器上，装完就能用，不需要服务器、不需要联网
 *             （AI 功能除外，那要连模型接口）
 *   服务器 —— 连一台已经部署好的实例，团队共用一份数据
 *
 * 新装的默认是本地；从旧版本升上来的保持原样连服务器，见 读配置()。
 */
const { app, BrowserWindow, shell, dialog, Menu, clipboard } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const 本地服务 = require("./local-server");

const APP_NAME = "Daedalus CRM";

/**
 * 把用户数据目录挪到一个**不含空格**的路径下。
 *
 * 默认会是 ~/Library/Application Support/Daedalus CRM —— 名字里有空格，
 * 而数据库地址是以 `file:` URL 的形式交给 Prisma 的，空格在那里是雷。
 * 必须在 app ready 之前改，否则 Electron 自己的缓存已经落在旧路径上了。
 */
const 旧数据目录 = app.getPath("userData");
app.setPath("userData", path.join(app.getPath("appData"), "DaedalusCRM"));
const 数据根 = app.getPath("userData");

const CONFIG_FILE = path.join(数据根, "config.json");
const 数据目录 = path.join(数据根, "data");
const 日志文件 = path.join(数据根, "logs", "server.log");
const 密码文件 = path.join(数据目录, ".init-password");

/** 随包发布的本地服务。打包后在 Resources/server，开发时在 desktop/server-bundle */
const 服务目录 = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(__dirname, "server-bundle");

/** 旧版本默认指向的托管版地址，只在从旧配置迁移过来时用得上 */
const 默认服务器 = process.env.CRM_URL || "https://app.ai-daedalus.com";

let win = null;
/** 本地服务起来之后的地址与一次性令牌 */
let 本地 = null;

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
    };
  } catch {
    return { mode: "local", serverUrl: 默认服务器 };
  }
}

function 写配置(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

/* ---------- 启动 ---------- */

async function 启动本地() {
  本地 = await 本地服务.start({ bundleDir: 服务目录, dataDir: 数据目录, logFile: 日志文件 });
}

/** 本地模式的首页：带令牌换一张会话票据，换完自己跳去 /dashboard */
function 本地入口() {
  return `http://127.0.0.1:${本地.port}/api/desktop/session?t=${本地.token}`;
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
    // 页面由服务端渲染，没法在里面标 -webkit-app-region 拖动区，
    // 所以保留系统标题栏，否则窗口拖不动
    titleBarStyle: "default",
    backgroundColor: "#fafafa",
    show: false,
    icon: path.join(__dirname, "assets/icon.png"),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
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

/* ---------- 菜单 ---------- */

function 显示本机密码() {
  let 密码 = null;
  try {
    密码 = fs.readFileSync(密码文件, "utf8").trim();
  } catch {
    /* 还没建库，或者是从旧版本升上来的库 */
  }
  if (!密码) {
    dialog.showMessageBox(win ?? null, {
      type: "info",
      title: "本机账号",
      message: "还没有本机密码",
      detail: "本地数据库还没建立，或者它是从别处搬来的。先用一次本地模式再来看。",
    });
    return;
  }
  dialog
    .showMessageBox(win ?? null, {
      type: "info",
      title: "本机账号",
      message: "管理员账号：admin",
      detail: `密码：${密码}\n\n本地模式下打开应用就是登录状态，平时用不到它。\n登出之后、或者把这个库搬到服务器上时才需要。`,
      buttons: ["复制密码", "好"],
      defaultId: 0,
    })
    .then(({ response }) => {
      if (response === 0) clipboard.writeText(密码);
    });
}

function 建菜单() {
  const cfg = 读配置();
  const isMac = process.platform === "darwin";
  const 应用菜单 = {
    label: APP_NAME,
    submenu: [
      { role: "about", label: `关于 ${APP_NAME}` },
      { type: "separator" },
      {
        label: "使用本机数据",
        type: "radio",
        checked: cfg.mode === "local",
        click: () => 切到本地(),
      },
      {
        label: cfg.mode === "server" ? `连接服务器（${cfg.serverUrl}）…` : "连接服务器…",
        type: "radio",
        checked: cfg.mode === "server",
        click: () => 问服务器地址(),
      },
      { type: "separator" },
      { label: "本机账号密码…", enabled: cfg.mode === "local", click: 显示本机密码 },
      { label: "打开数据文件夹", click: () => shell.openPath(数据目录) },
      { label: "查看服务日志", click: () => shell.showItemInFolder(日志文件) },
      { type: "separator" },
      ...(isMac ? [{ role: "hide", label: `隐藏 ${APP_NAME}` }] : []),
      { role: "quit", label: `退出 ${APP_NAME}` },
    ],
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      应用菜单,
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
        label: "视图",
        submenu: [
          { role: "reload", label: "重新加载" },
          { role: "resetZoom", label: "实际大小" },
          { role: "zoomIn", label: "放大" },
          { role: "zoomOut", label: "缩小" },
          { type: "separator" },
          { role: "togglefullscreen", label: "全屏" },
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
    if (读配置().mode === "local") {
      try {
        await 启动本地();
      } catch (e) {
        报告本地故障(e?.message ?? String(e));
        return;
      }
    }
    建窗口();
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
