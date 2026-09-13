/**
 * Daedalus CRM 桌面客户端。
 *
 * 只是一个原生窗口：数据和业务逻辑都在服务器上。它存在的意义有三个——
 * 常驻 Dock / 任务栏、独立窗口不跟一堆浏览器标签混在一起、断网时给一句人话提示。
 *
 * 服务器地址可改：托管版默认指向我们的服务器，自部署的人填自己的地址，
 * 同一个安装包两边都能用。
 */
const { app, BrowserWindow, shell, dialog, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const CONFIG_FILE = path.join(app.getPath("userData"), "config.json");
const DEFAULT_URL = process.env.CRM_URL || "https://47.82.123.132.sslip.io";
const APP_NAME = "Daedalus CRM";

function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return { serverUrl: (c.serverUrl || DEFAULT_URL).replace(/\/+$/, "") };
  } catch {
    return { serverUrl: DEFAULT_URL };
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

let win;

function createWindow() {
  const { serverUrl } = readConfig();

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: APP_NAME,
    // 页面来自远程服务器，没法在里面标 -webkit-app-region 拖动区，
    // 所以必须保留系统标题栏，否则窗口拖不动
    titleBarStyle: "default",
    backgroundColor: "#fafafa",
    show: false,
    icon: path.join(__dirname, "assets/icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.loadURL(serverUrl);

  // 站外链接交给系统浏览器，免得用户在应用窗口里迷路、又没有地址栏可回退
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(readConfig().serverUrl)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  win.webContents.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 是主动取消（比如自己发起的跳转打断了上一次加载），不是错误
    if (code === -3) return;
    dialog
      .showMessageBox(win, {
        type: "warning",
        title: "连不上服务器",
        message: `连接 ${readConfig().serverUrl} 失败`,
        detail: `${desc}（${code}）\n\n检查一下网络，或确认服务器地址填对了。`,
        buttons: ["重试", "改服务器地址", "退出"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) win.loadURL(readConfig().serverUrl);
        else if (response === 1) promptServerUrl();
        else app.quit();
      });
  });
}

function promptServerUrl() {
  // Electron 没有内置输入框，用一个极简页面代替
  const input = new BrowserWindow({
    width: 480,
    height: 240,
    resizable: false,
    title: "服务器地址",
    parent: win,
    modal: true,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  const cur = readConfig().serverUrl;
  input.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`
    <body style="font:14px -apple-system,'PingFang SC','Microsoft YaHei';padding:22px;margin:0;background:#fafafa">
      <div style="font-weight:600;margin-bottom:10px">服务器地址</div>
      <input id="u" value="${cur}" style="width:100%;padding:9px 11px;font-size:14px;
        border:1px solid #d9dee7;border-radius:7px;box-sizing:border-box">
      <div style="margin-top:8px;color:#6b7280;font-size:12px">
        用我们的托管版就保持默认；自己部署的填自己的地址。
      </div>
      <div style="margin-top:20px;text-align:right">
        <button onclick="window.close()" style="padding:7px 16px;margin-right:8px">取消</button>
        <button onclick="crm.save(document.getElementById('u').value)"
          style="padding:7px 16px;background:#2f6bff;color:#fff;border:none;border-radius:6px">保存</button>
      </div>
    </body>`),
  );
  input.webContents.once("ipc-message", (_e, ch, url) => {
    if (ch !== "save-url") return;
    const clean = String(url).trim().replace(/\/+$/, "");
    // 只认 http(s)：填错协议会让窗口白屏，且看不出是为什么
    if (!/^https?:\/\/.+/.test(clean)) return;
    writeConfig({ serverUrl: clean });
    input.close();
    win.loadURL(clean);
  });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const 应用菜单 = {
    label: APP_NAME,
    submenu: [
      { role: "about", label: `关于 ${APP_NAME}` },
      { type: "separator" },
      { label: "服务器设置…", click: promptServerUrl },
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

// 单实例：重复点图标时聚焦已开的窗口，而不是开第二个
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
