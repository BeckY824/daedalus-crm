/**
 * 团队同步的定时器（2026-10-03，0.46.15 第 5 块）：每 30 秒、切回应用时戳一下本地服务 /api/desktop/sync。
 *
 * 和提醒（reminders.js）一样住在壳里：Mac 上关了窗口应用还在，同事的改动照样该拉下来。
 * 真正的活（推、拉、解密、合并）在本地服务里做（src/lib/sync/client.ts），壳只管什么时候叫。
 * 没加入团队时本地服务直接回「跳过」，一次请求几毫秒。
 */
const 间隔 = 30_000;

function 开始({ 取端口, 取令牌, fetch: 拿 = globalThis.fetch }) {
  let 在跑 = false;
  let 计时 = null;
  async function 一轮() {
    if (在跑) return;
    const port = 取端口();
    const token = 取令牌();
    if (!port || !token) return; // 连着服务器 / 本地服务还没起
    在跑 = true;
    try {
      await 拿(`http://127.0.0.1:${port}/api/desktop/sync`, { method: "POST", headers: { "x-desktop-token": token }, signal: AbortSignal.timeout(120_000) });
    } catch {
      /* 本地服务重启中、云端连不上：下一轮再来，出错原因本地服务自己记在 .team.json 里 */
    } finally {
      在跑 = false;
    }
  }
  计时 = setInterval(一轮, 间隔);
  const 首次 = setTimeout(一轮, 10_000);
  return {
    刷新: () => void 一轮(),
    停: () => { clearInterval(计时); clearTimeout(首次); },
  };
}

module.exports = { 开始, 间隔 };
