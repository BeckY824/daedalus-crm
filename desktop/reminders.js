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
 *      外贸模版（2026-10-03）再加上订单里超期 / 今天到期的节点——左栏「跟进」和「订单」两个角标之和，
 *      人从 Dock 看见 5，打开应用两个角标加起来就是 5。
 *      不做「未读」——一个人用的软件没有未读这回事。
 *   2. **早上一条，不是 N 条**：到了设定的钟点发一次汇总；那时应用没开，就在今天第一次打开时补发。
 *      一天一次，发过就记下来，重启也不重发。没有要跟进的就不发——「今天没事」不值得打扰人。
 *   3. **到点只叫一次**：定了钟点的计划（「3 点给王总回电话」）到点发一条，点一下直接到那位客户。
 *      改了时间算新的一条（键里带着时刻），重启不重发。
 *      合盖睡过了 10 分钟回看的（D-049）：醒来**合成一条**「你有 N 条提醒在合盖时到点了」，不一条条补叫，
 *      也不一声不吭——人只会觉得提醒坏了。只算睡前就看见要来的（应用刚打开不算合盖，那时早报会说逾期）。
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

/** 订单节点那两个数。老的本地服务不回 订单，当 0 */
const 订单数 = (摘要) => ((摘要 && 摘要.订单 && 摘要.订单.超期) | 0) + ((摘要 && 摘要.订单 && 摘要.订单.今天) | 0);

function 角标数(设置, 摘要) {
  if (!设置.角标 || !摘要) return 0;
  return Math.max(0, (摘要.逾期 | 0) + (摘要.今天 | 0) + 订单数(摘要));
}

function 该发早报(设置, 状态, 摘要, now) {
  if (!设置.早报 || !摘要) return false;
  if ((摘要.逾期 | 0) + (摘要.今天 | 0) + 订单数(摘要) === 0) return false;
  if (状态.早报日 === 今天串(now)) return false;
  return now >= 今天的(设置.早报时间, now);
}

function 早报文案(摘要) {
  const 共 = (摘要.逾期 | 0) + (摘要.今天 | 0);
  const 单 = 订单数(摘要);
  const 订 = 摘要.订单 || { 超期: 0, 今天: 0, 最久: null };
  /** 订单那半句：超期的点名最久那一单那一步；都是今天到期的就这么说 */
  const 订单话 = () => {
    if ((订.超期 | 0) > 0) {
      const 点名 = 订.最久 ? `，最久的是订单 ${订.最久.no}「${订.最久.节点}」，拖了 ${订.最久.天} 天` : "";
      return `订单节点超期 ${订.超期} 个${点名}`;
    }
    return "订单节点都是今天到期的";
  };
  if (共 === 0) return { 标题: `今天有 ${单} 个订单节点要看`, 正文: 订单话() };
  const 标题 = 单 > 0 ? `今天有 ${共} 个要跟进、${单} 个订单节点要看` : `今天有 ${共} 个要跟进`;
  const 跟进话 =
    摘要.逾期 > 0
      ? `其中 ${摘要.逾期} 个已经逾期${摘要.最久 ? `，最久的是${摘要.最久.客户}，已经拖了 ${摘要.最久.天} 天` : ""}`
      : "都是今天的，还没有逾期的";
  return { 标题, 正文: 单 > 0 ? `跟进${跟进话.replace(/^其中 /, "里 ")}；${订单话()}` : 跟进话 };
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

/**
 * 合盖时错过的（D-049）：服务端给的「错过」里，壳睡前就见过（见过 里有）、还没叫过的。
 * 见过 = 之前每一轮「定时」里出现过的键；应用刚打开时是空的，所以不会把开机前的旧事当成合盖错过。
 */
function 合盖错过的(设置, 状态, 摘要, 见过) {
  if (!设置.到点 || !摘要 || !Array.isArray(摘要.错过)) return [];
  const 已 = new Set(状态.已提醒 ?? []);
  return 摘要.错过.filter((x) => 见过.has(到点键(x)) && !已.has(到点键(x)));
}

/** 本机时区的 HH:mm */
function 钟点(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function 错过文案(列) {
  const 前几 = 列.slice(0, 3).map((x) => `${钟点(x.at)} ${x.标题}${x.客户 ? `（${x.客户}）` : ""}`);
  const 余 = 列.length > 3 ? `，还有 ${列.length - 3} 条` : "";
  return {
    标题: `你有 ${列.length} 条提醒在合盖时到点了`,
    正文: 前几.join("；") + 余,
    // 一条就直接去那位客户；几条去跟进计划，那里按时间排好了
    去: 列.length === 1 ? `/customers/${列[0].customerId}?focus=${encodeURIComponent(列[0].key)}` : "/follow-ups/plans",
  };
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
  const 取文件 = typeof 文件 === "function" ? 文件 : () => 文件;
  let 当前文件 = 取文件();
  let 状态 = 读(当前文件);
  let 已停 = false;
  let 在跑 = false;
  let 上次摘要 = null;
  /** 之前每一轮「定时」里见过的到点键（只在内存里：应用重开不算合盖），见 合盖错过的 */
  const 见过 = new Set();

  function 跟上账号() {
    const next = 取文件();
    if (next === 当前文件) return;
    当前文件 = next;
    状态 = 读(next);
    上次摘要 = null;
    见过.clear();
    设角标(0);
  }

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
    if (在跑 || 已停) return;
    跟上账号();
    const 本轮文件 = 当前文件;
    const 本轮令牌 = 取令牌();
    在跑 = true;
    try {
      // 压根没有可问的（切去了服务器模式、本地服务没起）：Dock 上不许挂着一个过期的数
      if (!取端口() || !取令牌()) 上次摘要 = null;
      const 摘要 = await 问();
      // 请求发出后切换账号或关闭：旧账号结果不能给新账号发通知或写状态。
      if (已停 || 本轮文件 !== 取文件() || 本轮令牌 !== 取令牌()) return;
      // 问不到（服务在重启、在切账号）就保持上一次的数，不闪成 0 再跳回来
      if (摘要) 上次摘要 = 摘要;
      设角标(角标数(状态.设置, 上次摘要));
      if (!摘要) return;
      const now = 现在();
      let 改了 = false;
      const 错过 = 合盖错过的(状态.设置, 状态, 摘要, 见过);
      if (错过.length) {
        const 文 = 错过文案(错过);
        通知(文.标题, 文.正文, 文.去);
        状态.已提醒 = [...状态.已提醒, ...错过.map(到点键)];
        改了 = true;
      }
      for (const x of Array.isArray(摘要.定时) ? 摘要.定时 : []) 见过.add(到点键(x));
      // 见过的只留两天内的，和 已提醒 一样别越攒越多
      for (const k of 见过) if (!清旧([k], now).length) 见过.delete(k);
      for (const x of 该到点的(状态.设置, 状态, 摘要, now)) {
        const 文 = 到点文案(x);
        // 带上是哪一条：记录页据此把那条计划 / 待办闪一下，不用人自己找
        通知(文.标题, 文.正文, `/customers/${x.customerId}?focus=${encodeURIComponent(x.key)}`);
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
        写(当前文件, 状态);
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
    设置: () => { 跟上账号(); return 状态.设置; },
    改设置(新) {
      跟上账号();
      状态.设置 = 规整设置({ ...状态.设置, ...(新 && typeof 新 === "object" ? 新 : {}) });
      写(当前文件, 状态);
      // 关掉角标要立刻生效，不等下一分钟
      设角标(角标数(状态.设置, 上次摘要));
      return 状态.设置;
    },
    停() {
      已停 = true;
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
  合盖错过的,
  错过文案,
  清旧,
  今天串,
  今天的,
};
