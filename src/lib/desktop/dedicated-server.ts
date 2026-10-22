import fs from "node:fs";
import path from "node:path";

/**
 * 专属服务器（2026-10-21，客户 Even 的 30 人团队要连只给他们用的国内云端）。
 *
 * 登录页上填一次地址、或者粘一个我们发的「专属服务器码」，记在本机数据根目录的
 * dedicated-server.json 里。壳每次启动把这个文件的路径传给本地服务（CRM_SERVER_FILE，
 * desktop/main.js），`云端地址()` 每次现读它——登录、同步、手机二维码、AI、反馈全跟着走。
 * 放在数据根而不是账号目录：它管的是「这台电脑连哪套云端」，登录之前就要知道，换账号也不变。
 *
 * 规矩：
 *   - **设了就只认它，绝不悄悄退回正式服**：连不上就说连不上（带着它的地址），文件坏了也不退。
 *   - 只在没登录时能设、能退：手上的令牌是哪套云端发的就只对哪套有效。
 *   - 自动更新不看这个文件（desktop/updater.js 有自己的源），专属客户和大家拿同一个包。
 */

export const 正式服 = "https://app.ai-daedalus.com";

/**
 * 文件在、却读不出一个能用的地址时，`云端地址()` 给的就是这个：`.invalid` 永远解析不了，
 * 每个请求都会老老实实失败、登录页说清原因——而不是把专属客户的账号和数据悄悄发去正式服。
 */
export const 读不出的地址 = "https://dedicated-server-unreadable.invalid";

export type 专属服务器 = { 状态: "无" } | { 状态: "有"; url: string; name: string } | { 状态: "坏了" };

/** 服务器码的前缀。码就是「前缀 + base64url(JSON {u: 地址, n: 名字})」，见 desktop/scripts/server-code.mjs */
const 码前缀 = "DCRM-";

function 文件(): string | null {
  return process.env.CRM_SERVER_FILE || null;
}

/** 填进来的地址规整成「协议 + 主机 + 路径」，末尾不带斜杠。不是 http(s) 的、带账号密码的一律不收 */
export function 规整地址(输入: string): { ok: true; url: string } | { ok: false; error: string } {
  let s = 输入.trim();
  if (!s) return { ok: false, error: "请填专属服务器的地址，或者粘贴专属服务器码" };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "这不像一个服务器地址。地址长这样：https://cn.example.com" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "地址要以 https:// 开头" };
  if (u.username || u.password) return { ok: false, error: "地址里不要带账号密码" };
  if (!u.hostname) return { ok: false, error: "这不像一个服务器地址。地址长这样：https://cn.example.com" };
  return { ok: true, url: `${u.origin}${u.pathname.replace(/\/+$/, "")}` };
}

export function 编码服务器码(url: string, name = ""): string {
  return 码前缀 + Buffer.from(JSON.stringify({ u: url, n: name })).toString("base64url");
}

/** 解不开就是 null：调用方把它当地址再试一次（多半也不像地址，会说清楚） */
export function 解码服务器码(码: string): { url: string; name: string } | null {
  const s = 码.replace(/\s+/g, "");
  if (!s.toUpperCase().startsWith(码前缀)) return null;
  try {
    const d = JSON.parse(Buffer.from(s.slice(码前缀.length), "base64url").toString("utf8")) as { u?: unknown; n?: unknown };
    if (typeof d.u !== "string") return null;
    const r = 规整地址(d.u);
    if (!r.ok) return null;
    return { url: r.url, name: typeof d.n === "string" ? d.n.trim().slice(0, 40) : "" };
  } catch {
    return null;
  }
}

/** 每次现读：文件很小，而且设了、退了都要马上生效，不用重启本地服务 */
export function 读专属服务器(): 专属服务器 {
  const f = 文件();
  if (!f) return { 状态: "无" };
  let 原文: string;
  try {
    原文 = fs.readFileSync(f, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? { 状态: "无" } : { 状态: "坏了" };
  }
  try {
    const d = JSON.parse(原文) as { url?: unknown; name?: unknown };
    const r = typeof d.url === "string" ? 规整地址(d.url) : null;
    if (!r?.ok) return { 状态: "坏了" };
    return { 状态: "有", url: r.url, name: typeof d.name === "string" ? d.name : "" };
  } catch {
    return { 状态: "坏了" };
  }
}

export function 主机(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 先写临时文件再改名：写一半断电留下的是没用的临时文件，不是半截设置 */
function 写(内容: { url: string; name: string }) {
  const f = 文件();
  if (!f) throw new Error("没有 CRM_SERVER_FILE");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const 临时 = `${f}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(临时, JSON.stringify({ ...内容, setAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.renameSync(临时, f);
  } catch (e) {
    fs.rmSync(临时, { force: true });
    throw e;
  }
}

/**
 * 连之前先问一声它是不是我们的云端：GET /api/account/policy（不要凭证，正式服、专属服都有）。
 * 2xx + JSON 对象 + register 是布尔值才算；别的都说清是哪一种，**不存**。
 */
async function 认一认(url: string, 超时毫秒: number): Promise<string | null> {
  const 机 = 主机(url);
  let res: Response;
  try {
    res = await fetch(`${url}/api/account/policy`, { signal: AbortSignal.timeout(超时毫秒), cache: "no-store" });
  } catch (e) {
    const 超时 = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return 超时
      ? `${机} ${Math.round(超时毫秒 / 1000)} 秒没回应。检查地址有没有写错、网络通不通，稍后再试。`
      : `连不上 ${机}。检查地址有没有写错、网络通不通。`;
  }
  if (res.status === 404) return `${机} 上没有 Daedalus CRM 的账号服务（回了 404）。检查地址有没有写错。`;
  if (!res.ok) return `${机} 回了 ${res.status}，可能正在重启。过几分钟再试；地址写错了也会这样。`;
  let d: unknown = null;
  try {
    d = JSON.parse(await res.text());
  } catch {
    /* 下面一起说 */
  }
  if (!d || typeof d !== "object" || Array.isArray(d) || typeof (d as { register?: unknown }).register !== "boolean") {
    return `${机} 回的不是 Daedalus CRM 服务器的内容。检查地址有没有写错；公司网或酒店 Wi-Fi 要先在浏览器里登录上网。`;
  }
  return null;
}

export type 设置结果 = { ok: true; 状态: 专属服务器 } | { ok: false; error: string };

/**
 * 填进来的是地址或服务器码。先认一认，认过了才存；填的就是正式服，等于退出专属服务器。
 * 调用方负责「没登录才能换」（login/actions.ts）。
 */
export async function 设专属服务器(输入: string, 超时毫秒 = 15_000): Promise<设置结果> {
  if (!文件()) return { ok: false, error: "这一版桌面端还不能设专属服务器，请先升级" };
  const 码 = 解码服务器码(输入);
  if (!码 && 输入.trim().toUpperCase().startsWith(码前缀)) return { ok: false, error: "专属服务器码不完整。请把我们发的那一整段原样粘进来" };
  const 规整 = 码 ? { ok: true as const, url: 码.url } : 规整地址(输入);
  if (!规整.ok) return 规整;
  if (规整.url === 正式服) {
    退出专属服务器();
    return { ok: true, 状态: { 状态: "无" } };
  }
  const 错 = await 认一认(规整.url, 超时毫秒);
  if (错) return { ok: false, error: 错 };
  const name = 码?.name ?? "";
  写({ url: 规整.url, name });
  return { ok: true, 状态: { 状态: "有", url: 规整.url, name } };
}

export function 退出专属服务器() {
  const f = 文件();
  if (f) fs.rmSync(f, { force: true });
}
