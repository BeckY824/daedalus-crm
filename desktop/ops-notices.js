/**
 * 运营通知（2026-10-02）：运营台有新注册、新反馈、用量异常，弹系统通知。
 * **只有运营名单里那一个账号的这台电脑会起它**：main.js 在 查运营台() 说能开时才 开始()，
 * 说不能（换了人、被移出名单、退出登录）立刻 停()、把游标文件删掉。云端那头再验一道（/api/ops/notices 403）。
 *
 * 和 reminders.js 一个路数：主进程自己定时问，关了窗口也照样叫。
 *   - 游标存在 ops-notices.json：下次从上次问到的那一刻接着问，重启不重发、不漏
 *   - 第一次问不带 since，云端只回一个 now：刚开起来不补旧账
 *   - 已发的键留两天，防同一件事（同一个钟头的用量异常）被叫第二次
 *
 * 纯规则是下面几个纯函数，tests/desktop-ops-notices.test.ts 钉着。
 */
const fs = require("node:fs");

const 问一次间隔 = 2 * 60_000;
const 键留多久 = 2 * 86_400_000;

function 读(文件) {
  try {
    const j = JSON.parse(fs.readFileSync(文件, "utf8"));
    return {
      游标: typeof j.游标 === "string" ? j.游标 : null,
      已发: j.已发 && typeof j.已发 === "object" && !Array.isArray(j.已发) ? j.已发 : {},
    };
  } catch {
    return { 游标: null, 已发: {} };
  }
}

function 写(文件, 状态) {
  try {
    fs.writeFileSync(文件, JSON.stringify(状态, null, 2));
  } catch {
    /* 写不下只影响重启后会不会重发一次 */
  }
}

/** 这一批里哪些该发：没发过的。键 → 发出的时刻 */
function 要发的(事件, 已发) {
  if (!Array.isArray(事件)) return [];
  return 事件.filter((e) => e && typeof e.key === "string" && !(e.key in 已发));
}

/** 两天前发过的键扔掉 */
function 清旧(已发, now) {
  const 出 = {};
  for (const [k, t] of Object.entries(已发)) if (now - Number(t) < 键留多久) 出[k] = t;
  return 出;
}

/** 云端给的 path 只认运营台里的路径：点通知不会被带去别处 */
function 去处(p) {
  return typeof p === "string" && /^\/admin(\/[A-Za-z0-9_-]+)*$/.test(p) ? p : "/admin";
}

/**
 * 串起来。问（since）→ { now, 事件 } | null；通知（标题, 正文, 去处）。
 * 返回 { 刷新, 停 }。停() 会删掉游标文件：下一个坐到这台电脑前、又恰好被加进名单的人从头开始。
 */
function 开始({ 文件, 问, 通知, 现在 = () => Date.now() }) {
  let 状态 = 读(文件);
  let 在跑 = false;
  let 停了 = false;

  async function 一轮() {
    if (在跑 || 停了) return;
    在跑 = true;
    try {
      const r = await 问(状态.游标).catch(() => null);
      // 问不到（断网、云端在重启）：游标不动，下次接着从那儿问
      if (!r || typeof r.now !== "string" || 停了) return;
      const now = 现在();
      for (const e of 要发的(r.事件, 状态.已发)) {
        通知(String(e.标题 ?? ""), String(e.正文 ?? ""), 去处(e.path));
        状态.已发[e.key] = now;
      }
      状态 = { 游标: r.now, 已发: 清旧(状态.已发, now) };
      写(文件, 状态);
    } finally {
      在跑 = false;
    }
  }

  const 定时器 = setInterval(() => void 一轮(), 问一次间隔);
  const 首次 = setTimeout(() => void 一轮(), 5_000);

  return {
    刷新: () => 一轮(),
    停() {
      停了 = true;
      clearInterval(定时器);
      clearTimeout(首次);
      try {
        fs.rmSync(文件, { force: true });
      } catch {
        /* 本来就没有 */
      }
    },
  };
}

module.exports = { 开始, 要发的, 清旧, 去处, 读 };
