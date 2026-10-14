/** Windows toast 的协议激活。URI 只带一次性随机编号，目标路由只存在原实例内存中。
 * https://learn.microsoft.com/uwp/schemas/tiles/toastschema/element-toast
 * 不依赖 WinRT Activated 回调；协议启动的辅助进程在主程序初始化前转发并退出。
 */
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const 协议 = "daedalus-crm-notify";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const 管道名 = id => `\\\\.\\pipe\\daedalus-crm-toast-${id}`;
function 解析激活(argv) {
  for (const value of argv) {
    if (typeof value !== "string" || value.length > 160) continue;
    try {
      const u = new URL(value);
      if (u.protocol !== `${协议}:` || u.username || u.password || u.port || u.search || u.hash) continue;
      const token = u.pathname.slice(1);
      if (uuid.test(u.hostname) && uuid.test(token)) return { instance: u.hostname.toLowerCase(), token: token.toLowerCase() };
    } catch { /* 非 URI 参数 */ }
  }
  return null;
}
function 转交激活(argv, { 取管道名 = 管道名, 超时 = 2000 } = {}) {
  const target = 解析激活(argv);
  if (!target) return Promise.resolve(false);
  return new Promise(resolve => {
    let done = false;
    const socket = net.createConnection(取管道名(target.instance));
    const finish = ok => { if (done) return; done = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(超时, () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("end", () => finish(false));
    socket.once("connect", () => socket.write(`${target.token}\n`));
    let response = "";
    socket.on("data", chunk => {
      response += chunk.toString();
      if (response.length > 16) return finish(false);
      if (response.includes("\n")) finish(response === "ok\n");
    });
  });
}
async function 创建激活入口({ 取管道名 = 管道名, 记事件 = () => {} } = {}) {
  const instance = randomUUID();
  const callbacks = new Map();
  let live = true;
  const log = event => { try { 记事件({ event }); } catch { /* 不记录 URI/编号/目标路径 */ } };
  const server = net.createServer(socket => {
    socket.setTimeout(2000, () => socket.destroy());
    socket.on("error", () => {});
    let input = "";
    let handled = false;
    socket.on("data", chunk => {
      if (handled) return;
      input += chunk.toString();
      if (input.length > 80) return socket.destroy();
      if (!input.includes("\n")) return;
      handled = true;
      const token = input.slice(0, -1);
      const action = input === `${token}\n` && uuid.test(token) ? callbacks.get(token) : null;
      if (!action) { log("activation-rejected"); socket.end("no\n"); return; }
      callbacks.delete(token); // 接收即消费，不能重放；实际导航仍由通知上下文校验。
      log("activation-received");
      try { action(); socket.end("ok\n"); }
      catch { log("activation-failed"); socket.end("no\n"); }
    });
  });
  server.on("error", () => { live = false; callbacks.clear(); log("listener-failed"); });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(取管道名(instance), () => { server.removeListener("error", reject); resolve(); });
  });
  server.unref();
  return {
    登记(action) {
      if (!live) throw new Error("Windows 通知入口不可用");
      const token = randomUUID(); callbacks.set(token, action);
      return { uri: `${协议}://${instance}/${token}`, 取消: () => callbacks.delete(token) };
    },
    关闭() { live = false; callbacks.clear(); return new Promise(resolve => server.close(resolve)); },
  };
}
const xml = s => String(s ?? "").replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
function 通知XML(options, uri) {
  if (!解析激活([uri])) throw new Error("通知激活地址不对");
  return `<toast activationType="protocol" launch="${xml(uri)}"><visual><binding template="ToastGeneric"><text>${xml(options.title)}</text><text>${xml(options.body)}</text></binding></visual>${options.silent ? '<audio silent="true"/>' : ''}</toast>`;
}
module.exports = { 协议, 管道名, 解析激活, 转交激活, 创建激活入口, 通知XML };
