/**
 * 主窗口的桥。主窗口里跑的是本地服务的页面（服务器模式下则是托管站），
 * 页面拿到的只有这两组能力，地址和路径都由主进程自己的状态决定，页面传不进任何参数——
 * 所以就算页面被换掉也做不了别的。
 *
 *   desktopUpdate —— 更新：问状态、请求下载、请求安装、请求检查、打开下载页，外加一个订阅
 *   desktopNotify —— 跑完了叫人一声：页面只传两段字，弹不弹（窗口在不在前台）由主进程判断
 *   desktopNav    —— 菜单里的「设置…」（⌘,）：**让页面自己 push 过去**，不是壳去 loadURL。
 *                    差别是设置那一层——软导航才命中拦截路由，才是盖在当前页上的浮层；
 *                    硬跳转落到的是整页。收到就立刻回一声 nav:ok，主进程据此知道
 *                    「对面有人接」；没人接（登录页、老版本的托管站）它会退回硬跳转。
 *   desktopShell  —— 壳的杂事，给设置页「桌面端」那一栏用：备份数据库、打开数据文件夹、
 *                    查看服务日志、复制诊断信息、连接服务器、问版本号。
 *                    这些原来都在系统菜单里（2026-09-17 之前）；菜单按 Claude 桌面端那套
 *                    改成标准项之后，它们搬进了应用页面。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopUpdate", {
  state: () => ipcRenderer.invoke("update:state"),
  download: () => ipcRenderer.invoke("update:download"),
  install: () => ipcRenderer.invoke("update:install"),
  check: () => ipcRenderer.invoke("update:check"),
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
  openDataDir: () => ipcRenderer.invoke("shell:open-data"),
  openLogs: () => ipcRenderer.invoke("shell:open-logs"),
  diagnostics: () => ipcRenderer.invoke("shell:diagnostics"),
  useServer: (url) => ipcRenderer.invoke("shell:use-server", String(url ?? "")),
  /**
   * 换了云端账号：换数据目录、重起本地服务、重载窗口。页面传不进任何参数——
   * 换成谁由主进程自己去读 .cloud.json，页面说了不算。
   */
  switchAccount: () => ipcRenderer.invoke("shell:switch-account"),
});

contextBridge.exposeInMainWorld("desktopNotify", {
  通知: (标题, 正文) => ipcRenderer.invoke("notify:show", { 标题: String(标题 ?? ""), 正文: String(正文 ?? "") }),
});

contextBridge.exposeInMainWorld("desktopNav", {
  onGo: (cb) => {
    const h = (_e, 路径) => {
      // 先应答再执行：主进程只等 400ms，cb 里哪怕抛了也不该让它以为没人接
      ipcRenderer.send("nav:ok");
      cb(String(路径));
    };
    ipcRenderer.on("nav:go", h);
    return () => ipcRenderer.removeListener("nav:go", h);
  },
});
