const { contextBridge, ipcRenderer } = require("electron");

/**
 * 只暴露这几个能力，不开放任何其它 Node 权限。
 * 用到它们的两个页面都是我们自己用 data: URL 拼出来的极简表单
 * （Electron 没有内置输入框，只能这么画）。
 *
 * 云端那几个是**单向发出去**的，结果经 onReply 回来：多步表单里
 * 「码发出去了」「密码太短」这类反馈要显示在窗口里，弹一个原生对话框
 * 盖在模态窗上，点掉之后人还得重新找自己填到哪了。
 */
contextBridge.exposeInMainWorld("crm", {
  save: (url) => ipcRenderer.send("save-url", url),
  open: (url) => ipcRenderer.send("open-external", url),
  policy: () => ipcRenderer.send("cloud-policy"),
  login: (target, password) => ipcRenderer.send("cloud-login", { target, password }),
  code: (target) => ipcRenderer.send("cloud-code", { target }),
  reset: (payload) => ipcRenderer.send("cloud-reset", payload),
  onReply: (cb) => ipcRenderer.on("cloud-reply", (_e, m) => cb(m)),
});
