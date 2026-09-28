/**
 * 桌面端的提醒：Dock 上的数字、早上一条汇总、定了钟点的计划到点叫一声。
 *
 * ## 为什么在壳里，不在页面里
 *
 * Mac 上关了窗口应用还在 Dock 里——页面没了，主进程还在。提醒恰恰是人不看着应用时才有用的东西，
 * 所以由主进程每分钟问本地服务一次（/api/desktop/reminders，拿启动令牌认），自己定时、自己发。
 * 页面只在人改了设置、或者刚完成一条计划时喊一声「现在就再问一次」。
 *
 * ## 三条规矩（照 Codex：通知少，每一条都要你做点什么）
 *
 *   1. **Dock 上的数只有一个意思**：今天到期 + 已逾期、还没做的跟进。0 就不显示。
 *      不做「未读」——一个人用的软件没有未读这回事。
 *   2. **早上一条，不是 N 条**：到了设定的钟点发一次汇总；那时应用没开，就在今天第一次打开时补发。
 *      一天一次，发过就记下来，重启也不重发。没有要跟进的就不发——「今天没事」不值得打扰人。
 *   3. **到点只叫一次**：定了钟点的计划（「3 点给王总回电话」）到点发一条，点一下直接到那位客户。
 *      改了时间算新的一条（键里带着时刻），重启不重发。
 *
 * 纯规则（发不发、说什么、写几）是下面几个纯函数，tests/desktop-reminders.test.ts 钉着；
 * `开始()` 只负责把它们串到定时器、文件和 Electron 上。
 */
const fs = require("node:fs");

const 默认设置 = { 角标: true, 早报: true, 早报时间: "09:00", 到点: true };
/** 到点提醒的容错：一分钟问一次，电脑刚从睡眠里醒来可能错过几轮，过了这么久就不补了——再补就是马后炮 */
const 到点容错毫秒 = 10 * 60_000;
const 问一次间隔 = 60_000;

/** 本机时区的 YYYY-MM-DD。「今天发没发过早报」按人坐的那台电脑的日历算 */
function 今天串(now) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** "09:00" → 今天那个时刻。写坏了就按 9 点，不让一个坏设置把早报整个吞掉 */
function 今天的(时刻, now) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(时刻 ?? ""));
  const h = m ? Math.min(23, Number(m[1])) : 9;
  const mi = m ? Math.min(59, Number(m[2])) : 0;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi);
}

function 规整设置(s) {
  const x = { ...默认设置, ...(s && typeof s === "object" ? s : {}) };
  return {
    角标: x.角标 !== false,
    早报: x.早报 !== false,
    早报时间: /^\d{1,2}:\d{2}$/.test(String(x.早报时间)) ? String(x.早报时间) : 默认设置.早报时间,
    到点: x.到点 !== false,
  };
}

function 角标数(设置, 摘要) {
  if (!设置.角标 || !摘要) return 0;
  return Math.max(0, (摘要.逾期 | 0) + (摘要.今天 | 0));
}

function 该发早报(设置, 状态, 摘要, now) {
  if (!设置.早报 || !摘要) return false;
  if ((摘要.逾期 | 0) + (摘要.今天 | 0) === 0) return false;
  if (状态.早报日 === 今天串(now)) return false;
  return now >= 今天的(设置.早报时间, now);
}

function 早报文案(摘要) {
  const 共 = (摘要.逾期 | 0) + (摘要.今天 | 0);
  const 标题 = `今天有 ${共} 个要跟进`;
  if (摘要.逾期 > 0) {
    const 点名 = 摘要.最久 ? `，最久的是${摘要.最久.客户}，已经拖了 ${摘要.最久.天} 天` : "";
    return { 标题, 正文: `其中 ${摘要.逾期} 个已经逾期${点名}` };
  }
  return { 标题, 正文: "都是今天的，还没有逾期的" };
}

/** 到点提醒的键：同一条计划改了时间就是新的一条 */
const 到点键 = (x) => `${x.key}@${x.at}`;

function 该到点的(设置, 状态, 摘要, now) {
  if (!设置.到点 || !摘要 || !Array.isArray(摘要.定时)) return [];
  const 已 = new Set(状态.已提醒 ?? []);
  return 摘要.定时.filter((x) => {
    const t = Date.parse(x.at);
    return Number.isFinite(t) && t <= now.getTime() && now.getTime() - t < 到点容错毫秒 && !已.has(到点键(x));
  });
}

function 到点文案(x) {
  return { 标题: `到点了：${x.标题}`, 正文: [x.客户, x.方式].filter(Boolean).join(" · ") };
}

/** 已提醒的只留两天内的：键里带着时刻，旧的不会再用到，别让这份文件越长越大 */
function 清旧(已提醒, now) {
  return (已提醒 ?? []).filter((k) => {
    const t = Date.parse(String(k).split("@").pop());
    return Number.isFinite(t) && now.getTime() - t < 2 * 86_400_000;
  });
}

function 读(文件) {
  try {
    const j = JSON.parse(fs.readFileSync(文件, "utf8"));
    return { 设置: 规整设置(j.设置), 早报日: typeof j.早报日 === "string" ? j.早报日 : null, 已提醒: Array.isArray(j.已提醒) ? j.已提醒 : [] };
  } catch {
    return { 设置: 规整设置(null), 早报日: null, 已提醒: [] };
  }
}

function 写(文件, 状态) {
  try {
    fs.writeFileSync(文件, JSON.stringify(状态, null, 2));
  } catch {
    // 写不下只影响「重启后会不会重发一次」，不该让提醒整个停掉
  }
}

/**
 * 串起来。依赖全从外面给：取端口、取令牌（本地服务每次重启都会换）、发通知、设角标、打开到某一页。
 * 返回 { 刷新, 设置, 改设置, 停 }。
 */
function 开始({ 文件, 取端口, 取令牌, 通知, 设角标, 现在 = () => new Date(), fetch: 取 = fetch }) {
  let 状态 = 读(文件);
  let 在跑 = false;
  let 上次摘要 = null;

  async function 问() {
    const port = 取端口();
    const token = 取令牌();
    if (!port || !token) return null;
    try {
      const r = await 取(`http://127.0.0.1:${port}/api/desktop/reminders`, {
        headers: { "x-desktop-token": token },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  async function 一轮() {
    if (在跑) return;
    在跑 = true;
    try {
      // 压根没有可问的（切去了服务器模式、本地服务没起）：Dock 上不许挂着一个过期的数
      if (!取端口() || !取令牌()) 上次摘要 = null;
      const 摘要 = await 问();
      // 问不到（服务在重启、在切账号）就保持上一次的数，不闪成 0 再跳回来
      if (摘要) 上次摘要 = 摘要;
      设角标(角标数(状态.设置, 上次摘要));
      if (!摘要) return;
      const now = 现在();
      let 改了 = false;
      for (const x of 该到点的(状态.设置, 状态, 摘要, now)) {
        const 文 = 到点文案(x);
        通知(文.标题, 文.正文, `/customers/${x.customerId}`);
        状态.已提醒 = [...状态.已提醒, 到点键(x)];
        改了 = true;
      }
      if (该发早报(状态.设置, 状态, 摘要, now)) {
        const 文 = 早报文案(摘要);
        通知(文.标题, 文.正文, "/follow-ups/plans");
        状态.早报日 = 今天串(now);
        改了 = true;
      }
      if (改了) {
        状态.已提醒 = 清旧(状态.已提醒, now);
        写(文件, 状态);
      }
    } finally {
      在跑 = false;
    }
  }

  const 定时器 = setInterval(() => void 一轮(), 问一次间隔);
  // 本地服务刚起来那几秒可能还没就绪，稍等一下再问第一次
  const 首次 = setTimeout(() => void 一轮(), 8_000);

  return {
    刷新: () => 一轮(),
    设置: () => 状态.设置,
    改设置(新) {
      状态.设置 = 规整设置({ ...状态.设置, ...(新 && typeof 新 === "object" ? 新 : {}) });
      写(文件, 状态);
      // 关掉角标要立刻生效，不等下一分钟
      设角标(角标数(状态.设置, 上次摘要));
      return 状态.设置;
    },
    停() {
      clearInterval(定时器);
      clearTimeout(首次);
      设角标(0);
    },
  };
}

module.exports = {
  开始,
  默认设置,
  规整设置,
  角标数,
  该发早报,
  早报文案,
  该到点的,
  到点文案,
  清旧,
  今天串,
  今天的,
};
