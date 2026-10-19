/**
 * 主窗口的桥。主窗口里跑的是本地服务的页面（服务器模式下则是托管站），
 * 页面拿到的只有这两组能力，地址和路径都由主进程自己的状态决定，页面传不进任何参数——
 * 所以就算页面被换掉也做不了别的。
 *
 *   desktopUpdate —— 更新：问状态、请求下载、请求安装、请求检查、打开下载页，外加一个订阅
 *   desktopNotify —— 跑完了叫人一声：页面只传两段字，弹不弹（窗口在不在前台）由主进程判断
 *   desktopNav    —— 菜单里的「设置…」（⌘,）：**让页面自己 push 过去**，不是壳去 loadURL。
 *                    差别是设置那一层——软导航才命中拦截路由，才是盖在当前页上的浮层；
 *                    硬跳转落到的是整页。页面接住后回 nav:ok；没接住或处理抛错时退回硬跳转。
 *   desktopShell  —— 壳的杂事，给设置页「桌面端」那一栏用：备份数据库、打开数据文件夹、
 *                    查看服务日志、复制诊断信息、连接服务器、问版本号、Windows 点 × 怎么办。
 *                    这些原来都在系统菜单里（2026-09-17 之前）；菜单按 Claude 桌面端那套
 *                    改成标准项之后，它们搬进了应用页面。
 */
const { contextBridge, ipcRenderer } = require("electron");

/*
  Windows（2026-10-14）：系统标题栏不画了，右上角的最小化 / 最大化 / 关闭由系统叠在页面上（主进程 titleBarOverlay）。
  这里做两件事：
    1. 给 <html> 挂 os-win，样式表据此让出右上角那条、压深字色（globals.css「Windows 桌面端」那几条）；
    2. 看右上角那块页面是什么底色，报给主进程把三个钮的底色和符号色对上——换主题、开关毛玻璃、
       右边面板开合都会变，所以盯着 <html> 的属性，再每秒对一次（取一个点的颜色，很便宜）。
  毛玻璃开着时底是透的，钮的底也给透明，不然右上角会顶着一块实色。
*/
if (process.platform === "win32") {
  const 挂 = () => document.documentElement && document.documentElement.classList.add("os-win");
  挂();
  let 上次 = "";
  const 实色 = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || "");
    if (!m) return null;
    const [r, g, b, a = "1"] = m[1].split(",").map((x) => x.trim());
    return Number(a) < 0.5 ? null : `rgb(${r}, ${g}, ${b})`;
  };
  const 报 = () => {
    const html = document.documentElement;
    if (!html || !document.body) return;
    let 底 = null;
    if (!html.classList.contains("glass")) {
      for (let el = document.elementFromPoint(window.innerWidth - 60, 18); el && !底; el = el.parentElement) 底 = 实色(getComputedStyle(el).backgroundColor);
      底 = 底 || 实色(getComputedStyle(document.body).backgroundColor) || "#fafafa";
    }
    const 符号 = getComputedStyle(html).getPropertyValue("--ink-soft").trim() || "#374151";
    const 值 = JSON.stringify({ color: 底 || "#00000000", symbolColor: 符号 });
    if (值 === 上次) return;
    上次 = 值;
    ipcRenderer.send("shell:titlebar", JSON.parse(值));
  };
  window.addEventListener("DOMContentLoaded", () => {
    挂();
    报();
    new MutationObserver(报).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-skin", "data-paper"] });
    window.setInterval(报, 1000);
  });
  window.addEventListener("load", 报);
}

/*
  毛玻璃：开着就给 <html> 挂 glass 类，样式表据此把底色调成半透明（globals.css「毛玻璃」那一节）。
  同步问——异步的话第一帧先画实底再变透明，闪一下。中途在设置里拨了开关，主进程推一声过来。
*/
{
  const 挂 = (开) => document.documentElement.classList.toggle("glass", 开 === true);
  let 开 = false;
  try {
    开 = ipcRenderer.sendSync("shell:glass-now") === true;
  } catch {
    /* 老壳没有这个口子：当没开 */
  }
  if (document.documentElement) 挂(开);
  window.addEventListener("DOMContentLoaded", () => 挂(开));
  ipcRenderer.on("shell:glass", (_e, v) => {
    开 = v === true;
    挂(开);
  });
}

contextBridge.exposeInMainWorld("desktopUpdate", {
  state: () => ipcRenderer.invoke("update:state"),
  download: () => ipcRenderer.invoke("update:download"),
  install: () => ipcRenderer.invoke("update:install"),
  // 静默=true：左栏那一行自己显示结果，壳不弹对话框
  check: (静默) => ipcRenderer.invoke("update:check", 静默 === true),
  openDownload: () => ipcRenderer.invoke("update:open"),
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on("update:state", h);
    return () => ipcRenderer.removeListener("update:state", h);
  },
});

contextBridge.exposeInMainWorld("desktopShell", {
  version: () => ipcRenderer.invoke("shell:version"),
  backup: () => ipcRenderer.invoke("shell:backup"),
  autoBackups: () => ipcRenderer.invoke("shell:auto-backups"),
  restoreAutoBackup: (文件名) => ipcRenderer.invoke("shell:restore-auto-backup", String(文件名 ?? "")),
  openDataDir: () => ipcRenderer.invoke("shell:open-data"),
  openLogs: () => ipcRenderer.invoke("shell:open-logs"),
  diagnostics: () => ipcRenderer.invoke("shell:diagnostics"),
  useServer: (url) => ipcRenderer.invoke("shell:use-server", String(url ?? "")),
  /**
   * 换了云端账号：换数据目录、重起本地服务、重载窗口。页面传不进任何参数——
   * 换成谁由主进程自己去读 .cloud.json，页面说了不算。
   */
  switchAccount: () => ipcRenderer.invoke("shell:switch-account"),
  /** 毛玻璃：{ 可用, 开 }。可用=false（Windows 10、Linux）时设置页不摆这个开关 */
  glass: () => ipcRenderer.invoke("shell:glass"),
  setGlass: (开) => ipcRenderer.invoke("shell:set-glass", 开 === true),
  /** Windows 点 × 怎么办：{ 可用, 方式: ask | tray | quit }。可用=false（Mac）时设置页不摆这一栏（close-to-tray.js） */
  closeAction: () => ipcRenderer.invoke("shell:close-action"),
  setCloseAction: (方式) => ipcRenderer.invoke("shell:set-close-action", String(方式 ?? "")),
});

contextBridge.exposeInMainWorld("desktopNotify", {
  // 去：点通知回到哪一页（站内相对路径，主进程再校一遍）。老页面不传也行
  通知: (标题, 正文, 去) => ipcRenderer.invoke("notify:show", { 标题: String(标题 ?? ""), 正文: String(正文 ?? ""), 去: 去 ? String(去) : "" }),
});

/*
  desktopReminders —— 提醒的设置（Dock 数字 / 早上汇总 / 到点提醒）和「现在就再问一次」。
  设置只有这几个字段，由主进程规整；刷新不带参数。页面完成一条计划之后喊一声，Dock 上的数马上跟着变。
  同事新建的三个开关（设置 → 团队）：页面没带的就不传，不能把没带当成关（老页面只交四个字段）
*/
contextBridge.exposeInMainWorld("desktopReminders", {
  设置: () => ipcRenderer.invoke("reminders:get"),
  改设置: (s) => {
    const 新 = {};
    for (const k of ["角标", "早报", "到点", "同事客户", "同事商机", "同事跟进"]) if (s && k in s) 新[k] = Boolean(s[k]);
    if (s && "早报时间" in s) 新.早报时间 = String(s.早报时间 ?? "");
    return ipcRenderer.invoke("reminders:set", 新);
  },
  刷新: () => ipcRenderer.invoke("reminders:refresh"),
  试一条: () => ipcRenderer.invoke("reminders:test"),
});

contextBridge.exposeInMainWorld("desktopNav", {
  setCustomerLabel: (name) => ipcRenderer.invoke("nav:customer-label", name),
  onGo: (cb) => {
    const h = async (_e, 路径, requestId) => {
      // 页面没接住跳转时不确认，让主进程在 400ms 后走硬跳转。
      try {
        await cb(String(路径));
        ipcRenderer.send("nav:ok", requestId);
      } catch { /* 主进程兜底 */ }
    };
    ipcRenderer.on("nav:go", h);
    return () => ipcRenderer.removeListener("nav:go", h);
  },
});

/*
  团队同步收到了同事的改动（desktop/sync.js → main.js 发 team:changed）：页面刷新一下，
  老板盯着的跟进列表不用自己去点。只有通知，不带数据
*/
contextBridge.exposeInMainWorld("desktopTeam", {
  onChanged: (cb) => {
    const h = () => cb();
    ipcRenderer.on("team:changed", h);
    return () => ipcRenderer.removeListener("team:changed", h);
  },
});

/*
  desktopFeedback —— 我们回复了你的反馈（desktop/feedback-replies.js → main.js 发 feedback:changed）：
  壳每几分钟问一次，没看过的那几条变了喊一声，页面去本地服务再取一遍，左栏的红点跟着出 / 收。不带任何参数
*/
contextBridge.exposeInMainWorld("desktopFeedback", {
  onChanged: (cb) => {
    const h = () => cb();
    ipcRenderer.on("feedback:changed", h);
    return () => ipcRenderer.removeListener("feedback:changed", h);
  },
});
