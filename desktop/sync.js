/**
 * 团队同步的定时器（2026-10-03，0.46.15 第 5 块）：隔一会儿戳一下本地服务 /api/desktop/sync。
 *
 * 和提醒（reminders.js）一样住在壳里：Mac 上关了窗口应用还在，同事的改动照样该拉下来。
 * 真正的活（推、拉、解密、合并）在本地服务里做（src/lib/sync/client.ts），壳只管什么时候叫。
 * 没加入团队时本地服务直接回「跳过」，一次请求几毫秒。
 *
 * 多久一轮（2026-10-04 用户：3–5 人的团队版要快）：窗口在前台 8 秒一轮，在后台 30 秒，切回应用立刻一轮。
 * 一个团队 5 个人都在前台也就每秒不到一次请求，没有改动时推这一步不发、拉是一个空列表。
 * 这一轮收到了同事的改动：告诉窗口（有新改动），页面跟着刷新，不用人自己去点。
 */
const 前台间隔 = 8_000;
const 后台间隔 = 30_000;
/** 老名字：测试和别处读过它 */
const 间隔 = 后台间隔;

function 开始({ 取端口, 取令牌, 前台 = () => false, 有新改动 = () => {}, fetch: 拿 = globalThis.fetch }) {
  let 在跑 = false;
  let 计时 = null;
  let 停了 = false;
  async function 一轮() {
    if (在跑) return;
    const port = 取端口();
    const token = 取令牌();
    if (!port || !token) return; // 连着服务器 / 本地服务还没起
    在跑 = true;
    try {
      const r = await 拿(`http://127.0.0.1:${port}/api/desktop/sync`, { method: "POST", headers: { "x-desktop-token": token }, signal: AbortSignal.timeout(120_000) });
      const j = await r.json().catch(() => null);
      if (j && j.ok && Number(j.拉) > 0) 有新改动(Number(j.拉));
    } catch {
      /* 本地服务重启中、云端连不上：下一轮再来，出错原因本地服务自己记在 .team.json 里 */
    } finally {
      在跑 = false;
    }
  }
  function 排下一轮(ms) {
    if (停了) return;
    clearTimeout(计时);
    计时 = setTimeout(async () => {
      await 一轮();
      排下一轮(前台() ? 前台间隔 : 后台间隔);
    }, ms);
  }
  排下一轮(10_000);
  return {
    刷新: () => void 一轮(),
    停: () => { 停了 = true; clearTimeout(计时); },
  };
}

module.exports = { 开始, 间隔, 前台间隔, 后台间隔 };
