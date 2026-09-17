import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 桌面端本地模式的云端账号——**服务端这一份**。
 *
 * 数据在用户自己机器上，云端只剩两件事：认领一个账号，和借它调模型。
 * 桌面端拿到的是一枚长期设备令牌，直接当模型接口的 API Key 用。
 *
 * 2026-09-17 之前这套逻辑在 Electron 主进程里（desktop/cloud.js），登录窗是一段
 * data: URL 拼出来的 HTML，退出在系统菜单里。结果是桌面端有**两套身份、两扇门、两把密码**：
 * 云端账号（弹窗登录、菜单退出）和本机业务账号（网页 /login、随机密码、左下角退出）。
 * 用户在应用里点了左下角「退出登录」，落到的是一个要随机密码的框；菜单里那个
 * 「本机账号密码…」显示的又是建库那一刻的旧密码。两套身份就是乱的根源。
 *
 * 现在只留一套：云端账号。登录、退出、找回密码、改密码全在应用页面里，
 * 由这个模块对着云端接口办；Electron 只当壳。令牌仍然存在数据目录的 `.cloud.json`
 * （0600），和数据一起走——壳启动时和切回前台时还要读它做一次「还认不认」的校验。
 *
 * 只在 `DESKTOP_LOCAL=1` 的进程里有意义。托管版和自部署版调到这里一律拒绝，
 * 别让它们误写出一个 .cloud.json。
 */

export type 云端凭据 = {
  baseUrl: string;
  token: string;
  name: string;
  contact: string;
  /** 网关开放的模型，`id` 或 `id|说明` */
  models: string[];
  loggedAt: string;
};

export function 本地模式(): boolean {
  return process.env.DESKTOP_LOCAL === "1";
}

/** 我们的云端。留成变量是为了本机联调时能指到别处（壳从 CRM_CLOUD_URL 传进来） */
export function 云端地址(): string {
  return (process.env.CRM_CLOUD_URL || "https://app.ai-daedalus.com").replace(/\/+$/, "");
}

function 文件(): string {
  const dir = process.env.CRM_DATA_DIR;
  if (!dir) throw new Error("没有 CRM_DATA_DIR，不知道令牌该放哪");
  return path.join(dir, ".cloud.json");
}

export function 读(): 云端凭据 | null {
  if (!本地模式()) return null;
  try {
    const c = JSON.parse(fs.readFileSync(文件(), "utf8")) as Partial<云端凭据>;
    return c.token ? (c as 云端凭据) : null;
  } catch {
    return null;
  }
}

function 写(c: 云端凭据) {
  fs.mkdirSync(path.dirname(文件()), { recursive: true });
  fs.writeFileSync(文件(), JSON.stringify(c, null, 2), { mode: 0o600 });
}

export function 清() {
  try {
    fs.rmSync(文件(), { force: true });
  } catch {
    /* 本来就没有 */
  }
}

/** 这台机器的名字，登录时带上去。网页设置页「已登录的机器」那一栏靠它认出是哪台 */
export function 设备名(): string {
  return os.hostname().replace(/\.local$/, "").slice(0, 40) || "桌面端";
}

type 结果<T = unknown> = { ok: true; data: T } | { ok: false; error: string; 状态?: number };

/**
 * 连不上要当一个**结果**回去，不能让它抛出去：断网点登录，按钮一直转、一个字的提示都没有，
 * 看起来就是点了没反应。状态码也带回去——调用方要分得清「服务端明确拒了」和「根本没问到」。
 */
async function 请求<T = unknown>(url: string, init: RequestInit = {}, 超时毫秒 = 20_000): Promise<结果<T>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(超时毫秒), cache: "no-store" });
  } catch (e) {
    const 超时 = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      ok: false,
      error: 超时
        ? "服务器 20 秒没回应。检查一下网络，或者稍后再试。"
        : "连不上服务器。检查一下网络；如果在公司网里，可能要放行 app.ai-daedalus.com。",
    };
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 不是 JSON，下面按状态码处理 */
  }
  if (!res.ok) {
    const d = data as { error?: string | { message?: string } } | null;
    const msg = typeof d?.error === "string" ? d.error : (d?.error?.message ?? `服务器返回 ${res.status}`);
    return { ok: false, error: String(msg), 状态: res.status };
  }
  return { ok: true, data: data as T };
}

function 拒绝非本地(): 结果<never> | null {
  return 本地模式() ? null : { ok: false, error: "只有桌面端本地模式才有云端账号" };
}

/**
 * 这个部署开着哪两条路：网页那边还收不收新注册、能不能自助找回密码。
 * 登录页据此决定画哪几个入口——别摆一个点进去说「没开放」的链接。
 * 问不到（断网、老版本服务端）就按「都不开」算，只留登录，那是永远走得通的那条。
 */
export async function 策略(): Promise<{ register: boolean; reset: boolean }> {
  // 短超时：这一问挡在登录页渲染前面，断网时不能让人对着空白页等 20 秒
  const r = await 请求<{ register?: boolean; reset?: boolean }>(`${云端地址()}/api/account/policy`, {}, 5_000);
  if (!r.ok) return { register: false, reset: false };
  return { register: Boolean(r.data?.register), reset: Boolean(r.data?.reset) };
}

type 登录响应 = { token?: string; account?: { name?: string; contact?: string }; credits?: { 还剩?: number } };

/** 登录：账号密码换一枚长期设备令牌，顺手把可用模型拉下来，一起写进 .cloud.json */
export async function 登录(target: string, password: string): Promise<结果<{ name: string; contact: string; 还剩?: number }>> {
  const 拒 = 拒绝非本地();
  if (拒) return 拒;
  const 云 = 云端地址();
  const r = await 请求<登录响应>(`${云}/api/account/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, password, name: 设备名() }),
  });
  if (!r.ok) return r;
  const token = r.data?.token;
  if (!token) return { ok: false, error: "服务器没有返回令牌" };

  // 模型列表是首页那个选单——用户不用知道我们在后面接的是哪家。拉不到就空着，AI 仍然可用
  const m = await 请求<{ data?: { id: string; note?: string }[] }>(`${云}/api/gateway/v1/models`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const models = m.ok ? (m.data?.data ?? []).map((x) => (x.note ? `${x.id}|${x.note}` : x.id)).filter(Boolean) : [];

  const c: 云端凭据 = {
    baseUrl: 云,
    token,
    name: r.data?.account?.name ?? "",
    contact: r.data?.account?.contact ?? "",
    models,
    loggedAt: new Date().toISOString(),
  };
  写(c);
  return { ok: true, data: { name: c.name, contact: c.contact, 还剩: r.data?.credits?.还剩 } };
}

/**
 * 退出。先让服务端把令牌吊销掉——只删本地文件的话，令牌还在库里有效，
 * 谁抄走过它就一直能用我们的额度。吊不掉（断网）也照删本地那份：人要退，不能拦。
 */
export async function 退出(): Promise<void> {
  const c = 读();
  if (c) {
    await 请求(`${c.baseUrl}/api/account/token`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${c.token}` },
    }).catch(() => null);
  }
  清();
}

/** 要一封找回密码的验证码邮件 */
export async function 发码(target: string): Promise<结果<{ hint?: string }>> {
  const 拒 = 拒绝非本地();
  if (拒) return 拒;
  return 请求(`${云端地址()}/api/account/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, purpose: "reset" }),
  });
}

/**
 * 用验证码改密码。改完**所有地方都要重新登录**：网页会话全部作废，
 * 该账号名下的设备令牌也一起吊掉，包括这台机器手上这枚——调用方要接着把本地那份清掉。
 */
export async function 重置密码(input: { target: string; code: string; password: string }): Promise<结果> {
  const 拒 = 拒绝非本地();
  if (拒) return 拒;
  return 请求(`${云端地址()}/api/account/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export type 余额信息 = { 上限: number; 用掉: number; 还剩: number; 每日赠送?: number };

/** 还剩几次。问不到（断网）就是 null，设置页据此写「查不到」，不能把整页拖垮 */
export async function 余额(): Promise<余额信息 | null> {
  const c = 读();
  if (!c) return null;
  const r = await 请求<余额信息>(`${c.baseUrl}/api/gateway/v1/credits`, { headers: { Authorization: `Bearer ${c.token}` } });
  return r.ok ? r.data : null;
}

/**
 * 交给 llm.ts 的 AI 配置：那枚令牌就是 Key，网关就是接口地址。
 * 没登录返回 null——那时 AI 入口整个隐藏，CRM 其余功能照常，和自部署版没配 Key 时一样。
 * 每次调用都重新读文件：登录、退出要**即时**生效，不能像环境变量那样要重启服务才换。
 */
export function 模型配置(): { apiKey: string; baseUrl: string; account: string; models: string[] } | null {
  const c = 读();
  if (!c) return null;
  return {
    apiKey: c.token,
    baseUrl: `${c.baseUrl}/api/gateway/v1`,
    account: c.contact || c.name || "已登录",
    models: c.models?.length ? c.models : [],
  };
}
