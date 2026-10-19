/**
 * 我们回复了你的反馈：弹系统通知（2026-10-19）。
 *
 * 回复在云端。壳不直接问云端，问的是本地服务的 /api/desktop/feedback（它带设备令牌去问云端、按本机已读挑出没看过的），
 * 和 reminders.js 一个路数：主进程自己定时问，窗口关了（Mac 留在 Dock、Windows 收进托盘）也照样叫。
 *   - 启动后 8 秒问第一次，之后每 5 分钟一次；切回应用时 main.js 喊 刷新()，最多 5 分钟一次——
 *     和「这个账号能不能开运营台」那一轮（查运营台）同一个节奏：都是切回来时顺手问云端一句
 *   - 已经提醒过的回复 id 记在数据目录的 feedback-notified.json（跟着账号走），同一句不叫第二次
 *   - **这个文件还没有的时候（第一次装上这一版）只记不叫**：升级前就回过的那几封邮件不该一上来弹一串通知，
 *     它们照样在左栏红点、「我的反馈」里
 *   - 没看过的那几条变了，告诉窗口（feedback:changed），左栏的红点不用等人切回来才出
 *   - 没开系统通知权限：通知出口发了也看不见，红点和左下角的轻提示照样在
 *
 * 纯规则是下面几个纯函数，tests/desktop-feedback-replies.test.ts 钉着。
 */
const fs = require("node:fs");

const 问一次间隔 = 5 * 60_000;
const 切回来最多一次 = 5 * 60_000;
const 记多少 = 200;

function 读(文件) {
  if (!文件) return null;
  try {
    const j = JSON.parse(fs.readFileSync(文件, "utf8"));
    return Array.isArray(j.已提醒) ? j.已提醒.filter((x) => typeof x === "string") : [];
  } catch {
    return null;
  }
}

function 写(文件, 已提醒) {
  if (!文件) return;
  try {
    fs.writeFileSync(文件, JSON.stringify({ 已提醒: 已提醒.slice(-记多少) }, null, 2));
  } catch {
    /* 写不下只影响重启后会不会再叫一次 */
  }
}

/** 本地服务交来的一条：缺东西的丢掉（老本地服务 / 坏数据不让壳出错） */
function 规整(x) {
  if (!x || typeof x !== "object") return null;
  if (typeof x.feedbackId !== "string" || typeof x.回复id !== "string" || !x.feedbackId || !x.回复id) return null;
  return { feedbackId: x.feedbackId, 回复id: x.回复id, at: typeof x.at === "string" ? x.at : "", 回复: String(x.回复 ?? "") };
}

/** 压成一行再截，按码点截（emoji 不切半个） */
function 一句(s, n = 40) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  const 字 = [...t];
  return 字.length > n ? `${字.slice(0, n - 1).join("")}…` : t;
}

/** 这一批里哪些还没叫过 */
function 要提醒的(未读, 已提醒) {
  const 叫过 = new Set(已提醒);
  return (Array.isArray(未读) ? 未读 : []).map(规整).filter((x) => x && !叫过.has(x.回复id));
}

/** 一条：那一串；好几条：一条通知说几条，点了去「我的反馈」列表，正文是最新那句 */
function 文案(条们) {
  const 新到旧 = [...条们].sort((a, b) => b.at.localeCompare(a.at));
  const 头 = 新到旧[0];
  if (条们.length === 1) return { title: "我们回复了你的反馈", body: 一句(头.回复, 40), 去: `/feedback?id=${encodeURIComponent(头.feedbackId)}` };
  return { title: `我们回复了你的 ${条们.length} 条反馈`, body: 一句(头.回复, 40), 去: "/feedback" };
}

/** 没看过的那几条变没变：红点该不该跟着刷 */
function 签名(未读) {
  return (Array.isArray(未读) ? 未读 : []).map(规整).filter(Boolean).map((x) => x.回复id).sort().join(",");
}

/**
 * 串起来。文件：() => 当前账号的 feedback-notified.json（换账号跟着换）；取端口 / 取令牌：本地服务；
 * 通知({ title, body, 去 })；有变化()：没看过的那几条变了。返回 { 刷新, 停 }
 */
function 开始({ 文件, 取端口, 取令牌, 通知, 有变化 = () => {}, 取 = fetch, 现在 = () => Date.now() }) {
  let 在跑 = false;
  let 停了 = false;
  let 上次问 = 0;
  let 上次签名 = null;
  let 上次文件 = null;

  async function 问() {
    const port = 取端口();
    const token = 取令牌();
    if (!port || !token) return null;
    try {
      const r = await 取(`http://127.0.0.1:${port}/api/desktop/feedback`, { headers: { "x-desktop-token": token }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  async function 一轮() {
    if (在跑 || 停了) return;
    在跑 = true;
    上次问 = 现在();
    try {
      const 本轮文件 = 文件();
      if (本轮文件 !== 上次文件) {
        上次文件 = 本轮文件;
        上次签名 = null;
      }
      const r = await 问();
      // 问的这会儿换了账号：上一个人的回复不往这个人的文件里记、不替他叫
      if (!r || 停了 || 文件() !== 本轮文件) return;
      const 签 = 签名(r.未读);
      if (上次签名 !== null && 签 !== 上次签名) 有变化();
      上次签名 = 签;
      // 云端是老版本（没有这条接口）、没登录：什么都不记，等它能用了再从头记
      if (r.可用 !== true) return;
      const 记着 = 读(本轮文件);
      const 新的 = 要提醒的(r.未读, 记着 ?? []);
      if (记着 === null) {
        写(本轮文件, 新的.map((x) => x.回复id));
        return;
      }
      if (!新的.length) return;
      通知(文案(新的));
      写(本轮文件, [...记着, ...新的.map((x) => x.回复id)]);
    } finally {
      在跑 = false;
    }
  }

  const 定时器 = setInterval(() => void 一轮(), 问一次间隔);
  const 首次 = setTimeout(() => void 一轮(), 8_000);
  定时器.unref?.();
  首次.unref?.();

  return {
    /** 切回应用时：离上次问不到 5 分钟就不问。马上 = true 不看这个（测试、换账号后） */
    刷新(马上 = false) {
      if (!马上 && 现在() - 上次问 < 切回来最多一次) return Promise.resolve();
      return 一轮();
    },
    停() {
      停了 = true;
      clearInterval(定时器);
      clearTimeout(首次);
    },
  };
}

module.exports = { 开始, 要提醒的, 文案, 签名, 一句, 读 };
