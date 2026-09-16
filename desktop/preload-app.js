/**
 * 主窗口的桥，只有「更新」这一件事。
 *
 * 主窗口里跑的是本地服务的页面，服务器模式下则是托管站——不管哪种，页面拿到的只有
 * 这四个动作和一个订阅：问状态、请求安装、请求检查、打开下载页。地址由主进程自己的
 * 状态决定，页面传不进任何参数，所以就算页面被换掉也做不了别的。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopUpdate", {
  state: () => ipcRenderer.invoke("update:state"),
  install: () => ipcRenderer.invoke("update:install"),
  check: () => ipcRenderer.invoke("update:check"),
  openDownload: () => ipcRenderer.invoke("update:open"),
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on("update:state", h);
    return () => ipcRenderer.removeListener("update:state", h);
  },
});
