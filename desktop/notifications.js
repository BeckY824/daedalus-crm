/**
 * 保留通知对象，直到点击、失败或过期。Electron 38 的析构会移除原生通知的 delegate；
 * 只有函数内的临时引用时，系统通知还在，JS click 回调却可能已被回收。
 * Windows close 也会在横幅超时后触发，通知仍留在操作中心，不能在 close 时释放。
 * 依据：https://github.com/electron/electron/blob/v38.8.6/shell/browser/api/electron_api_notification.cc
 * 及同版本 docs/api/notification.md 的 close 事件说明。
 */
const { 通知XML } = require("./windows-toast-activation");
function 创建通知出口({ Notification, 取上下文, 取激活入口, 记事件 = () => {}, 最多 = 64, 保留毫秒 = 24 * 60 * 60_000 }) {
  const 活着 = new Map();
  let 序号 = 0;
  const 记 = (event, id, kind) => { try { 记事件({ event, id, kind }); } catch { /* 日志不阻止提醒 */ } };
  function 收掉(n) {
    const entry = 活着.get(n);
    if (!entry) return;
    活着.delete(n);
    clearTimeout(entry.timer);
    entry.activation?.取消();
    try { n.close(); } catch { /* 可能已被系统关闭 */ }
  }
  function 发(options, 点击, kind = "reminder") {
    if (!Notification.isSupported()) return { ok: false, 原因: "不支持" };
    let n, activation;
    const id = ++序号;
    try {
      const context = 取上下文();
      const click = () => {
        if (!活着.has(n)) return;
        const sameContext = 取上下文() === context;
        记(sameContext ? "clicked" : "stale-click-ignored", id, kind);
        收掉(n);
        if (!sameContext) return;
        try { Promise.resolve(点击?.()).catch(() => 记("navigation-failed", id, kind)); }
        catch { 记("navigation-failed", id, kind); }
      };
      if (取激活入口) {
        const entry = 取激活入口();
        if (!entry) return { ok: false, 原因: "Windows 通知点击入口不可用，请重新安装完整候选后重试" };
        activation = entry.登记(click);
        options = { ...options, toastXml: 通知XML(options, activation.uri) };
      }
      n = new Notification(options);
      const timer = setTimeout(() => { 记("expired", id, kind); 收掉(n); }, 保留毫秒);
      timer.unref?.();
      活着.set(n, { timer, activation });
      n.on("show", () => 记("shown", id, kind));
      n.on("close", () => 记("banner-closed", id, kind));
      n.once("failed", () => { 记("failed", id, kind); 收掉(n); });
      n.once("click", click);
      while (活着.size > 最多) 收掉(活着.keys().next().value);
      n.show();
      return { ok: true };
    } catch {
      if (n) 收掉(n);
      activation?.取消();
      记("failed", id, kind);
      return { ok: false, 原因: "系统通知发送失败" };
    }
  }
  return { 发, 清空: () => { for (const n of 活着.keys()) 收掉(n); } };
}
module.exports = { 创建通知出口 };
