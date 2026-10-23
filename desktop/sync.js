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
 * 老板那台，本地服务还会带上「同事新建」的那几条（lib/sync/team-notice.ts）：交给 同事新建，由 team-notices.js 决定怎么提醒。
 *
 * 2026-10-23 团队版用户报「上次同步」停了一个多小时：出错、超时、本地服务没回话都不退避，下一轮照常按 8 / 30 秒来；
 * 切回应用、电脑睡醒、解锁（main.js 接 powerMonitor）时 刷新：马上一轮，定时器也从这一刻重新排——
 * 睡眠、App Nap 拖过的那个计时器不再算数。断网恢复也一样：每 2 秒看一眼 在线()，从断到通马上一轮，不等下一个 30 秒。
 */
const 前台间隔 = 8_000;
const 后台间隔 = 30_000;
/** 老名字：测试和别处读过它 */
const 间隔 = 后台间隔;

/** 多久看一次网通没通：只读一个系统状态，不发请求 */
const 看网间隔 = 2_000;

/** 本地服务一轮最多等多久：它自己卡住一轮也会放开（lib/sync/client.ts 卡住限时），这里只是不让壳跟着干等 */
const 一轮限时 = 120_000;

function 开始({ 取端口, 取令牌, 前台 = () => false, 有新改动 = () => {}, 同事新建 = () => {}, fetch: 拿 = globalThis.fetch, 限时 = 一轮限时, 在线 = null }) {
  let 在跑 = false;
  let 计时 = null;
  let 停了 = false;
  async function 一轮() {
    if (在跑) return;
    const port = 取端口();
    const token = 取令牌();
    if (!port || !token) return; // 连着服务器 / 本地服务还没起
    在跑 = true;
    // 自己的闹钟（不用 AbortSignal.timeout）：测试里假时钟拨得动
    const 控 = new AbortController();
    const 闹 = setTimeout(() => 控.abort(), 限时);
    try {
      const r = await 拿(`http://127.0.0.1:${port}/api/desktop/sync`, { method: "POST", headers: { "x-desktop-token": token }, signal: 控.signal });
      const j = await r.json().catch(() => null);
      if (j && j.ok && Number(j.拉) > 0) 有新改动(Number(j.拉));
      // 「改完推一下」那几轮拉到的也在这里：这一轮自己拉到 0 条，照样可能带着
      if (j && Array.isArray(j.同事新建) && j.同事新建.length) {
        try { 同事新建(j.同事新建); } catch { /* 提醒出错不影响同步 */ }
      }
    } catch {
      /* 本地服务重启中、云端连不上：下一轮再来，出错原因本地服务自己记在 .team.json 里 */
    } finally {
      clearTimeout(闹);
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
  // 断网 → 恢复：马上一轮（main.js 传 net.isOnline）。没传就不看
  let 上回在线 = 在线 ? 在线() : true;
  const 看网 = 在线
    ? setInterval(() => {
        const 现在在线 = 在线();
        if (现在在线 && !上回在线) 排下一轮(0);
        上回在线 = 现在在线;
      }, 看网间隔)
    : null;
  return {
    /** 切回应用、睡醒、解锁、网络恢复：马上一轮，之后从这一刻起照常排 */
    刷新: () => 排下一轮(0),
    停: () => { 停了 = true; clearTimeout(计时); if (看网) clearInterval(看网); },
  };
}

module.exports = { 开始, 间隔, 前台间隔, 后台间隔, 一轮限时, 看网间隔 };
