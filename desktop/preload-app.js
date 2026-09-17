/**
 * 主窗口的桥。主窗口里跑的是本地服务的页面（服务器模式下则是托管站），
 * 页面拿到的只有这两组能力，地址和路径都由主进程自己的状态决定，页面传不进任何参数——
 * 所以就算页面被换掉也做不了别的。
 *
 *   desktopUpdate —— 更新：问状态、请求下载、请求安装、请求检查、打开下载页，外加一个订阅
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
});
