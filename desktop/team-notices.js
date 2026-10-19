/**
 * 老板提醒：同事新建了客户 / 商机 / 跟进（2026-10-19 客户反馈第 1 条）。
 *
 * 本地服务在同步那一轮里认出「同事新建的」（lib/sync/team-notice.ts，只在建团队的人那台、不含本人录的），
 * 经 desktop/sync.js 交到这里。这里只管两件事：开关（设置里三个，存在 reminders.json）和**别刷屏**：
 *
 *   1. 同一个人一分钟内录了好几条：合成一条。先发的那条收回，换成「王磊 新增 3 位客户」
 *   2. 电脑离线 / 合盖一段时间回来，一下同步下来几十条：整批只发一条「王磊等 3 人新增 12 位客户」。
 *      认法：这一批里有录了 5 分钟以上的（不是刚录的），或者一批里有 3 个人以上
 *
 * 点通知：只有一条 → 那位客户 / 那个商机；好几条 → 对应的列表页（客户 / 商机 / 跟进），混着的去客户列表。
 * 纯规则在下面，tests/desktop-team-notices.test.ts 钉着；发系统通知走 notifications.js 的出口（main.js 接上）。
 */
const 合并窗口毫秒 = 60_000;
const 补发界线毫秒 = 5 * 60_000;
const 汇总人数 = 3;
const 开关 = { 客户: "同事客户", 商机: "同事商机", 跟进: "同事跟进" };
const 量词 = { 客户: "位客户", 商机: "个商机", 跟进: "条跟进" };
const 列表页 = { 客户: "/customers", 商机: "/opportunities", 跟进: "/follow-ups" };
const 类序 = ["客户", "商机", "跟进"];

const 截 = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** 本地服务交来的一条：缺东西的、类不认识的丢掉（老本地服务 / 坏数据不让壳出错） */
function 规整(x) {
  if (!x || typeof x !== "object" || !开关[x.类]) return null;
  const 去 = typeof x.去 === "string" && x.去.startsWith("/") && !x.去.startsWith("//") ? x.去 : 列表页[x.类];
  return { 类: x.类, 谁: String(x.谁 ?? ""), 谁名: 截(x.谁名 || "同事", 20), 名: 截(x.名, 40), 题: x.题 ? 截(x.题, 40) : "", 去, at: Number(x.at) || 0 };
}

function 筛(列表, 设置) {
  return (Array.isArray(列表) ? 列表 : []).map(规整).filter((x) => x && 设置 && 设置[开关[x.类]] === true);
}

/** 「3 位客户、1 个商机」 */
function 数说(条们) {
  return 类序.map((类) => [类, 条们.filter((x) => x.类 === 类).length]).filter(([, n]) => n > 0).map(([类, n]) => `${n} ${量词[类]}`).join("、");
}

function 一条文案(x) {
  if (x.类 === "客户") return { title: `${x.谁名} 新建了客户`, body: x.名 || "（没填名字）", 去: x.去 };
  if (x.类 === "商机") return { title: `${x.谁名} 新建了商机`, body: x.名 || "（没填名字）", 去: x.去 };
  return { title: `${x.谁名} 记了一条跟进`, body: x.题 ? `${x.名}：${x.题}` : x.名, 去: x.去 };
}

function 合并文案(条们) {
  if (条们.length === 1) return 一条文案(条们[0]);
  const 人们 = [...new Map(条们.map((x) => [x.谁, x.谁名])).values()];
  const title = 人们.length === 1 ? `${人们[0]} 新增 ${数说(条们)}` : `${人们[0]}等 ${人们.length} 人新增 ${数说(条们)}`;
  const 名们 = [...new Set(条们.map((x) => x.名).filter(Boolean))];
  const body = 名们.length > 3 ? `${名们.slice(0, 3).join("、")} 等` : 名们.join("、");
  const 去们 = new Set(条们.map((x) => x.去));
  const 类们 = new Set(条们.map((x) => x.类));
  const 去 = 去们.size === 1 ? 条们[0].去 : 类们.size === 1 ? 列表页[条们[0].类] : 列表页.客户;
  return { title, body, 去 };
}

/**
 * 发：({ title, body, 去 }) => { ok, 收回? }。返回 { 收 }：收(列表, 设置) 返回这次发了哪几条文案（测试看）
 */
function 创建同事提醒({ 发, 现在 = () => Date.now() }) {
  /** 谁 → { 起, 条们, 收回 }：这个人一分钟窗口里已经提醒过的 */
  const 窗 = new Map();
  function 收(列表, 设置) {
    const 条们 = 筛(列表, 设置);
    if (!条们.length) return [];
    const now = 现在();
    for (const [谁, w] of 窗) if (now - w.起 >= 合并窗口毫秒) 窗.delete(谁);
    const 人们 = [...new Set(条们.map((x) => x.谁))];
    const 攒下的 = 条们.some((x) => x.at > 0 && now - x.at > 补发界线毫秒);
    if (攒下的 || 人们.length >= 汇总人数) {
      const 文案 = 合并文案(条们);
      发(文案);
      return [文案];
    }
    const 发了 = [];
    for (const 谁 of 人们) {
      const 他的 = 条们.filter((x) => x.谁 === 谁);
      let w = 窗.get(谁);
      if (w) {
        try { w.收回?.(); } catch { /* 系统已经关了那条 */ }
        w.条们.push(...他的);
      } else {
        w = { 起: now, 条们: 他的, 收回: null };
        窗.set(谁, w);
      }
      const 文案 = 合并文案(w.条们);
      const r = 发(文案);
      w.收回 = r && typeof r.收回 === "function" ? r.收回 : null;
      发了.push(文案);
    }
    return 发了;
  }
  return { 收, 清空: () => 窗.clear() };
}

module.exports = { 创建同事提醒, 合并文案, 一条文案, 数说, 筛, 合并窗口毫秒, 补发界线毫秒 };
