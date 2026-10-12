const { randomUUID } = require("node:crypto");

/** 页面成功接住这一次导航才确认；其他窗口、旧请求的确认不能取消兜底。 */
function 发送导航({ ipcMain, webContents, 路径, 仍有效, 兜底, 记事件 = () => {}, 等待毫秒 = 400 }) {
  const id = randomUUID();
  let timer;
  const 记 = event => { try { 记事件({ event, id }); } catch { /* 不影响导航 */ } };
  const 收尾 = () => {
    clearTimeout(timer);
    ipcMain.removeListener("nav:ok", 收);
    webContents.removeListener("destroyed", 收尾);
  };
  const 回退 = () => {
    收尾();
    if (!仍有效()) return;
    记("navigation-fallback");
    兜底();
  };
  const 收 = (event, requestId) => {
    if (event.sender !== webContents || requestId !== id) return;
    收尾();
    记("navigation-acknowledged");
  };
  ipcMain.on("nav:ok", 收);
  webContents.once("destroyed", 收尾);
  timer = setTimeout(回退, 等待毫秒);
  try { webContents.send("nav:go", 路径, id); 记("navigation-sent"); }
  catch { 回退(); }
}
module.exports = { 发送导航 };
