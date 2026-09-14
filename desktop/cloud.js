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
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 不是 JSON，下面按状态码处理 */
  }
  if (!res.ok) {
    const msg = data?.error?.message ?? data?.error ?? `服务器返回 ${res.status}`;
    return { ok: false, error: String(msg) };
  }
  return { ok: true, data };
}

/**
 * 登录。成功后顺便把可用模型拉下来——桌面端首页的模型选单就是它，
 * 用户不用知道我们在后面接的是哪家。
 */
async function 登录(target, password, baseUrl = 默认云端) {
  const 云 = baseUrl.replace(/\/+$/, "");
  const r = await 请求(`${云}/api/account/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, password, name: 设备名() }),
  });
  if (!r.ok) return r;

  const token = r.data?.token;
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
    name: r.data?.account?.name ?? "",
    contact: r.data?.account?.contact ?? "",
    models,
    loggedAt: new Date().toISOString(),
  });
  return { ok: true, data: { ...r.data, models } };
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
    ...(列表.length ? { LLM_MODELS: 列表.join(","), LLM_MODEL: 列表[0].split("|")[0] } : {}),
  };
}

module.exports = { 初始化, 读, 登录, 退出, 余额, 模型环境, 默认云端 };
