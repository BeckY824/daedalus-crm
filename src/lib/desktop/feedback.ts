import fs from "node:fs";
import path from "node:path";
import { 本地模式, 云端地址, 归属对不上, 读 as 读云端凭据 } from "./cloud";
import { 算未读, 排好, 规整反馈, type 带未读的反馈, type 已读表, type 我的一条反馈 } from "../feedback-unread";

/**
 * 「我的反馈」——**桌面端本地服务这一份**（2026-10-19）。
 *
 * 反馈和回复都在云端（控制面），这里只做两件事：
 *   1. 带着设备令牌去云端问「我的反馈」，顺手记一份（一分钟内左栏红点、轻提示、壳的定时问都用这份，不重复问）
 *   2. 已读记在本机：数据目录下 feedback-seen.json，反馈 id → 看过的最后一条回复。不上云——
 *      「看没看过」只关这台电脑，云端那头要记还得给老表加列（控制面只许加表）
 *
 * 云端是老版本、没有这条接口（404）：当作没有回复，界面照常，不报错。
 */

export type 取到的 =
  | { 可用: true; 反馈: 带未读的反馈[]; 未读数: number }
  | { 可用: false; 反馈: []; 未读数: 0; 原因: "没登录" | "老服务端" | "连不上" | "不是本人" };

const 缓存毫秒 = 60_000;
let 缓存: { 令牌: string; 时刻: number; 反馈: 我的一条反馈[] } | null = null;

function 已读文件(): string | null {
  const dir = process.env.CRM_DATA_DIR;
  return dir ? path.join(dir, "feedback-seen.json") : null;
}

export function 读已读(): 已读表 {
  const f = 已读文件();
  if (!f) return {};
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8")) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) return {};
    return Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === "string")) as 已读表;
  } catch {
    return {};
  }
}

/** 记下「这条反馈看到了这一条回复」。写不下只影响下次打开时红点还在 */
export function 记已读(feedbackId: string, 回复id: string) {
  const f = 已读文件();
  if (!f || !feedbackId || !回复id) return;
  const 表 = { ...读已读(), [feedbackId]: 回复id };
  try {
    fs.writeFileSync(f, JSON.stringify(表, null, 2), { mode: 0o600 });
  } catch {
    /* 同上 */
  }
}

/** 接着说之后、运营台可能刚回了：下一次问要问到最新的 */
export function 作废缓存() {
  缓存 = null;
}

function 带上未读(列: 我的一条反馈[]): 取到的 {
  const 已读 = 读已读();
  const 反馈 = 排好(列.map((f) => ({ ...f, 未读: 算未读(f, 已读) })));
  return { 可用: true, 反馈, 未读数: 反馈.filter((f) => f.未读).length };
}

/**
 * 问云端。新 = true：不用一分钟内那份（打开「我的反馈」页、壳的定时问）。
 * 问不到时有旧的就回旧的：断一下网，左栏的红点不该一闪没了又回来
 */
export async function 取我的反馈({ 新 = false }: { 新?: boolean } = {}): Promise<取到的> {
  if (!本地模式()) return { 可用: false, 反馈: [], 未读数: 0, 原因: "没登录" };
  const 凭据 = 读云端凭据();
  if (!凭据) return { 可用: false, 反馈: [], 未读数: 0, 原因: "没登录" };
  // 这个目录还是上一个账号的：不替别人报回复
  if (归属对不上()) return { 可用: false, 反馈: [], 未读数: 0, 原因: "不是本人" };
  if (!新 && 缓存 && 缓存.令牌 === 凭据.token && Date.now() - 缓存.时刻 < 缓存毫秒) return 带上未读(缓存.反馈);

  let r: Response;
  try {
    r = await fetch(`${云端地址()}/api/feedback/mine`, { headers: { Authorization: `Bearer ${凭据.token}` }, signal: AbortSignal.timeout(10_000) });
  } catch {
    if (缓存 && 缓存.令牌 === 凭据.token) return 带上未读(缓存.反馈);
    return { 可用: false, 反馈: [], 未读数: 0, 原因: "连不上" };
  }
  // 老服务端还没有这条接口：当作没有回复（新桌面端连旧服务端，10-19 定的口径）。
  // 云端明说了没有 / 令牌不认：旧的那份也扔掉，别在一分钟内还拿它冒红点
  if (r.status === 404 || r.status === 401) 缓存 = null;
  if (r.status === 404) return { 可用: false, 反馈: [], 未读数: 0, 原因: "老服务端" };
  if (r.status === 401) return { 可用: false, 反馈: [], 未读数: 0, 原因: "没登录" };
  if (!r.ok) {
    if (缓存 && 缓存.令牌 === 凭据.token) return 带上未读(缓存.反馈);
    return { 可用: false, 反馈: [], 未读数: 0, 原因: "连不上" };
  }
  const j = (await r.json().catch(() => null)) as { 反馈?: unknown } | null;
  const 列 = 规整反馈(j?.反馈);
  缓存 = { 令牌: 凭据.token, 时刻: Date.now(), 反馈: 列 };
  return 带上未读(列);
}

export type 发出结果 = { ok: true; 消息: 我的一条反馈["消息"][number] } | { ok: false; status: number; error: string };

/** 接着说：转给云端。clientKey 由页面生成，重发同一条用同一个 */
export async function 转发接着说(input: { feedbackId: string; body: string; clientKey: string }): Promise<发出结果> {
  const 凭据 = 读云端凭据();
  if (!凭据) return { ok: false, status: 503, error: "没登录云端账号，暂时发不出去" };
  let r: Response;
  try {
    r = await fetch(`${云端地址()}/api/feedback/mine`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${凭据.token}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, status: 502, error: "连不上，检查一下网络" };
  }
  const j = (await r.json().catch(() => ({}))) as { 消息?: unknown; error?: string };
  if (r.status === 404 && !j.error) return { ok: false, status: 502, error: "服务器还没升级，暂时只能写新反馈" };
  if (!r.ok) return { ok: false, status: r.status === 400 || r.status === 404 ? r.status : 502, error: j.error || "云端没收下，稍后再试" };
  作废缓存();
  const 消息 = 规整反馈([{ id: "x", at: "x", body: "x", 消息: [j.消息] }])[0]?.消息[0];
  if (!消息) return { ok: false, status: 502, error: "云端回的东西看不懂，刷新一下看看发出去没有" };
  return { ok: true, 消息 };
}
