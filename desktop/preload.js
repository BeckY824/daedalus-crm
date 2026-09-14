const { contextBridge, ipcRenderer } = require("electron");

/**
 * 只暴露两个能力，不开放任何其它 Node 权限。
 * 这两个页面都是我们自己用 data: URL 拼出来的极简表单（Electron 没有内置输入框）。
 */
contextBridge.exposeInMainWorld("crm", {
  save: (url) => ipcRenderer.send("save-url", url),
  login: (target, password) => ipcRenderer.send("cloud-login", { target, password }),
});
