const { contextBridge, ipcRenderer } = require("electron");

// 仅暴露保存服务器地址这一个能力，不开放其他 Node 权限
contextBridge.exposeInMainWorld("crm", {
  save: (url) => ipcRenderer.send("save-url", url),
});
