/**
 * 云端账号——**壳这一份**，只剩三件事：读令牌、清令牌、问一句还认不认。
 *
 * 登录、退出、找回密码、改密码、余额，2026-09-17 起全在应用页面里办
 * （src/lib/desktop/cloud.ts 对着云端接口），Electron 不再画登录窗、菜单里也不再有账号。
 * 原来这两处各一套，桌面端就有了两套身份、两扇门、两把密码——用户在应用里点了
 * 「退出登录」，落到的是一个要本机随机密码的框。并成一套之后，壳只需要知道
 * 「手上这枚令牌还有没有效」，据此决定启动时开门还是回登录页。
 *
 * 令牌存在数据目录的 .cloud.json（0600），和数据一起走。写它的是服务端那份。
 */
const fs = require("node:fs");
const path = require("node:path");

/** 我们的云端。留成变量是为了本机联调时能指到别处；起本地服务时原样传给它 */
const 默认云端 = process.env.CRM_CLOUD_URL || "https://app.ai-daedalus.com";

let 文件 = null;
function 初始化(dataDir) {
  文件 = path.join(dataDir, ".cloud.json");
}

function 读() {
  try {
    const c = JSON.parse(fs.readFileSync(文件, "utf8"));
    return c.token ? c : null;
  } catch {
    return null;
  }
}

function 清() {
  try {
    fs.rmSync(文件, { force: true });
  } catch {
    /* 本来就没有 */
  }
}

async function 请求(url, init = {}) {
  /**
   * 连不上要当一个**结果**回去，不能让它抛出去。状态码带回去：
   * 调用方要分得清「服务端明确拒了」和「根本没问到」（见 校验）。
   */
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    const 超时 = e?.name === "TimeoutError" || e?.name === "AbortError";
    return { ok: false, error: 超时 ? "服务器 20 秒没回应" : "连不上服务器" };
  }
  if (!res.ok) return { ok: false, error: `服务器返回 ${res.status}`, 状态: res.status };
  // 正文解不出来不算失败：调用方多数只关心「认不认」，只有 校验() 要读里面的 accountId
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 没正文或者不是 JSON */
  }
  return { ok: true, data };
}

/**
 * 手上这枚令牌还认不认。
 *
 * 两件事会让它作废：改密码（该账号名下**全部**吊销），以及在网页设置页的
 * 「已登录的机器」里单独退掉这一台。所以本地存着一枚不代表还能用——
 * 不问一句的话，应用照常开着，只有 AI 在背后一路 401，而用户看到的是
 * 「AI 怎么不响应了」，不会想到是自己刚在网页上做过什么。
 *
 * 三种结果要分清：
 *   认  —— 继续用
 *   不认（服务端明确说 401）—— 把本地那枚清掉，按未登录处理
 *   问不到（断网、服务器挂了）—— **当作还认**。飞机上打不开自己的 CRM 是更糟的事，
 *                               而真正的吊销下次联网时一定会被发现
 */
async function 校验() {
  const c = 读();
  if (!c) return { 有效: false, 原因: "没登录" };
  const r = await 请求(`${c.baseUrl}/api/gateway/v1/credits`, { headers: { Authorization: `Bearer ${c.token}` } });
  /*
    顺手把「你是谁」带回来。**升级上来的安装全靠这一下认领自己那份数据**：
    它的 .cloud.json 是 0.39.2 之前写的，里面没有账号 id，而人不会为了升级
    再登录一次。本地那份没有就用云端这份补上，见 main.js 启动那一段。
  */
  if (r.ok) return { 有效: true, accountId: c.accountId ?? r.data?.accountId ?? null };
  if (r.状态 === 401) {
    清();
    return { 有效: false, 原因: "已吊销" };
  }
  return { 有效: true, 离线: true };
}

/**
 * 从指定的 .cloud.json 里读账号 id。给 accounts.js 的迁移用——
 * 那一刻还没决定数据目录，所以不能走 读()（它认的是 初始化() 设好的那个路径）。
 * 读不出来就是 null，调用方据此把那份数据放进「未认领」，绝不猜一个账号塞给它。
 */
function 读账号id(文件路径) {
  try {
    const c = JSON.parse(fs.readFileSync(文件路径, "utf8"));
    return typeof c.accountId === "string" && c.accountId ? c.accountId : null;
  } catch {
    return null;
  }
}

module.exports = { 初始化, 读, 清, 校验, 读账号id, 默认云端 };
