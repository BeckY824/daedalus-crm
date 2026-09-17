/**
 * 云端账号。
 *
 * 本地模式下数据在这台机器上，云端只剩两件事：认领一个账号，和借它调模型。
 * 桌面端拿到的是一枚长期设备令牌，直接当模型接口的 API Key 用——于是本地那套
 * CRM 完全不知道"云端账号"这回事，它只看到「接口地址 + Key」，
 * 和用户自己填 DeepSeek 的 Key 走同一条代码路径。
 *
 * 令牌存在数据目录里（0600），和数据一起走。用户在设置页填了自己的 Key，
 * 那个优先级更高（llm.ts：界面配置 > 环境变量），等于自动就是 BYOK。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** 我们的云端。留成变量是为了本机联调时能指到别处 */
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

function 写(c) {
  fs.mkdirSync(path.dirname(文件), { recursive: true });
  fs.writeFileSync(文件, JSON.stringify(c, null, 2), { mode: 0o600 });
}

function 清() {
  try {
    fs.rmSync(文件, { force: true });
  } catch {
    /* 本来就没有 */
  }
}

/** 这台机器的名字，登录时带上去，用户在网页端能看出是哪台在用 */
function 设备名() {
  return `${os.hostname()}`.replace(/\.local$/, "").slice(0, 40) || "桌面端";
}

async function 请求(url, init = {}) {
  /**
   * 连不上要当一个**结果**回去，不能让它抛出去。
   *
   * 这一层原来不接网络错误：拔了网线点登录，fetch 直接 reject，
   * 一路穿过 ipc 处理函数变成一条没人接的 rejection——窗口上的按钮
   * 一直是禁用的「登录中」，一个字的提示都没有，看起来就是点了没反应。
   */
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    const 超时 = e?.name === "TimeoutError" || e?.name === "AbortError";
    return {
      ok: false,
      error: 超时
        ? "服务器 20 秒没回应。检查一下网络，或者稍后再试。"
        : "连不上服务器。检查一下网络；如果在公司网里，可能要放行 app.ai-daedalus.com。",
    };
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 不是 JSON，下面按状态码处理 */
  }
  if (!res.ok) {
    const msg = data?.error?.message ?? data?.error ?? `服务器返回 ${res.status}`;
    // 状态码带回去：调用方要分得清「服务端明确拒了」和「根本没问到」（见 校验）
    return { ok: false, error: String(msg), 状态: res.status };
  }
  return { ok: true, data };
}

/**
 * 拿到令牌之后要做的事：把可用模型拉下来、写进 .cloud.json。
 * 登录和注册两条路走到这里是一模一样的，所以只有这一份。
 * 模型列表是桌面端首页那个选单——用户不用知道我们在后面接的是哪家。
 */
async function 完成登录(云, data) {
  const token = data?.token;
  if (!token) return { ok: false, error: "服务器没有返回令牌" };

  let models = [];
  const m = await 请求(`${云}/api/gateway/v1/models`, { headers: { Authorization: `Bearer ${token}` } });
  if (m.ok) {
    models = (m.data?.data ?? [])
      .map((x) => (x.note ? `${x.id}|${x.note}` : x.id))
      .filter(Boolean);
  }

  写({
    baseUrl: 云,
    token,
    name: data?.account?.name ?? "",
    contact: data?.account?.contact ?? "",
    models,
    loggedAt: new Date().toISOString(),
  });
  return { ok: true, data: { ...data, models } };
}

/** 登录：账号密码换一枚长期设备令牌 */
async function 登录(target, password, baseUrl = 默认云端) {
  const 云 = baseUrl.replace(/\/+$/, "");
  const r = await 请求(`${云}/api/account/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, password, name: 设备名() }),
  });
  if (!r.ok) return r;
  return 完成登录(云, r.data);
}

/**
 * 这个部署开着哪两条路：网页那边还收不收新注册、能不能自助找回密码。
 * 登录窗打开时问一次，据此决定画哪几个入口——别摆一个点进去说「没开放」的链接。
 * 问不到（断网、老版本服务端）就按「都不开」算，只留登录，那是永远走得通的那条。
 */
async function 策略(baseUrl = 默认云端) {
  const r = await 请求(`${baseUrl.replace(/\/+$/, "")}/api/account/policy`);
  if (!r.ok) return { register: false, reset: false };
  return { register: Boolean(r.data?.register), reset: Boolean(r.data?.reset) };
}

/**
 * 要一封找回密码的验证码邮件。
 * 注册用的码不从这里要——注册整个在网页上办，见 main.js 里那个窗口的说明。
 */
async function 发码(target, baseUrl = 默认云端) {
  return 请求(`${baseUrl.replace(/\/+$/, "")}/api/account/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, purpose: "reset" }),
  });
}

/** 用验证码改密码。改完服务端会把之前签出去的网页会话全部作废，设备令牌不受影响 */
async function 重置密码({ target, code, password }, baseUrl = 默认云端) {
  return 请求(`${baseUrl.replace(/\/+$/, "")}/api/account/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, code, password }),
  });
}

/** 退出。先让服务端把令牌吊销掉——只删本地文件的话，令牌还在库里有效 */
async function 退出() {
  const c = 读();
  if (c) {
    await 请求(`${c.baseUrl}/api/account/token`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${c.token}` },
    }).catch(() => ({ ok: false }));
  }
  清();
}

/**
 * 手上这枚令牌还认不认。
 *
 * 2026-09-17 起改密码会把该账号名下的设备令牌**全部吊销**，所以本地存着一枚
 * 不代表还能用——不问一句的话，应用照常开着，只有 AI 在背后一路 401，
 * 而用户看到的是「AI 怎么不响应了」，不会想到是自己在网页上改过密码。
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
  if (r.ok) return { 有效: true };
  if (r.状态 === 401) {
    清();
    return { 有效: false, 原因: "已吊销" };
  }
  return { 有效: true, 离线: true };
}

async function 余额() {
  const c = 读();
  if (!c) return { ok: false, error: "还没登录云端账号" };
  return 请求(`${c.baseUrl}/api/gateway/v1/credits`, { headers: { Authorization: `Bearer ${c.token}` } });
}

/**
 * 交给本地服务的 AI 配置。没登录就返回空——那时 AI 入口整个隐藏，
 * CRM 其余功能照常，和自部署版没配 Key 时的表现完全一致。
 */
function 模型环境() {
  const c = 读();
  if (!c) return {};
  const 列表 = c.models?.length ? c.models : [];
  return {
    LLM_API_KEY: c.token,
    LLM_BASE_URL: `${c.baseUrl}/api/gateway/v1`,
    /**
     * 告诉本地服务「这把 Key 是你登录的云端账号给的」，不是运维在 .env 里配的。
     * 两者在设置页里要说不同的话：前者要显示是哪个账号、还剩几次免费，
     * 后者只能说「来自环境变量」。少了这个变量，桌面端用户会在设置页看到
     * 一句对他毫无意义的「当前 AI 配置来自服务器环境变量」。
     */
    CLOUD_ACCOUNT: c.contact || c.name || "已登录",
    /**
     * 本地库里的管理员就是这个账号（server-entry.js 据此改名、改登录邮箱）。
     * 本地模式 2026-09-15 起必须登录，用户打开应用看到的应该是自己，不是「管理员」。
     */
    DESKTOP_ACCOUNT_NAME: c.name || "",
    DESKTOP_ACCOUNT_CONTACT: c.contact || "",
    ...(列表.length ? { LLM_MODELS: 列表.join(","), LLM_MODEL: 列表[0].split("|")[0] } : {}),
  };
}

module.exports = { 初始化, 读, 登录, 策略, 发码, 重置密码, 退出, 校验, 余额, 模型环境, 默认云端 };
