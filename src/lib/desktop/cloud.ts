import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { 记AI余额 } from "../ai-credit-cache";

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
  /**
   * 云端账号 id。0.39.2 加的：桌面端按账号把数据分目录存（desktop/accounts.js），
   * 壳用它算出目录名。**升级上来的 .cloud.json 里没有这一项**——那时还没有它，
   * 而人不会为了升级再登录一次；壳会在启动校验那一下从云端补回来。
   */
  accountId?: string;
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

/**
 * 这个数据目录归哪个账号。壳在认领时写下的（desktop/accounts.js 的 `.owner`）。
 *
 * **不看 .cloud.json**：那是令牌，退出登录会被删掉。甲退出、乙在同一个目录上登录，
 * 那一刻 .cloud.json 不存在，就看不出「换人了」——于是乙的名字和邮箱会被写进甲的
 * User 表里。归属得是一份退出也不动的记号。
 *
 * 没有标记 = 未认领（第一次装应用，或者 0.39.2 之前升级上来还没认领过的那份），
 * 那种目录谁登录就归谁，不算换人。
 */
/**
 * 归属的自带校验的副本（2026-10-04 修 C-7）：「账号 id + 换行 + key(id)」，读时对得上 key 才算数。
 * .owner 被写成乱码时靠它认出原来的主人。和 desktop/accounts.js 的 归属校验文件 同名、同格式。
 */
const 归属校验文件名 = ".owner.check";

function 读校验过的归属(dir: string): string | null {
  try {
    const [id, k] = fs.readFileSync(path.join(dir, 归属校验文件名), "utf8").split("\n");
    return id && id.trim() && k?.trim() === 账号key(id) ? id.trim() : null;
  } catch {
    return null;
  }
}

/** 先写临时文件再改名：磁盘满时写一半留下的是没用的临时文件，不是半截 .owner */
function 原子写(文件: string, 内容: string) {
  const 临时 = `${文件}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(临时, 内容, { mode: 0o600 });
    fs.renameSync(临时, 文件);
  } catch (e) {
    fs.rmSync(临时, { force: true });
    throw e;
  }
}

function 记本目录归属(accountId: string) {
  const dir = process.env.CRM_DATA_DIR;
  if (!dir) return;
  try {
    原子写(path.join(dir, 归属校验文件名), `${accountId}\n${账号key(accountId)}\n`);
    原子写(path.join(dir, ".owner"), accountId);
  } catch (e) {
    /* 记不上：启动认领时还会再记一遍。但不再悄悄吞掉（2026-10-04 B-2 / D-024）——本地服务的输出进 server.log */
    console.error("[desktop] 记归属失败：", e instanceof Error ? e.message : e);
  }
}

/**
 * 「有主、只是还认不出是谁」的记号（2026-10-04 修 A-2 / D-021）。写进 .owner 时必须永远对不上任何真账号：
 * 云端账号 id 不会以「?」开头。和 desktop/accounts.js 的 认不出的主 是同一个值（tests/r2-shell-accounts.test.ts 钉着）。
 */
export const 认不出的主 = "?认不出";
/**
 * 待认的老令牌（A-2）：没主的目录上退出登录，那一刻又问不到云端这枚令牌是谁（断网、网慢），
 * 就把它挪到这儿留作「这份有主」的凭据，下一次有人登录（那时一定连得上）再拿它去问。
 * 和 desktop/accounts.js 的 待认文件 同名。
 */
const 待认文件名 = ".owner-pending.json";

export function 本目录归谁(): string | null {
  const dir = process.env.CRM_DATA_DIR;
  if (!dir) return null;
  // 自带校验的副本对得上就以它为准（C-7）：.owner 被写成乱码时认的还是原来的主人
  const 校验过的 = 读校验过的归属(dir);
  if (校验过的) return 校验过的;
  try {
    const v = fs.readFileSync(path.join(dir, ".owner"), "utf8").trim();
    if (v) return v;
  } catch {
    /* 没有标记 */
  }
  // A-2：没记主、但留着一枚还没问到是谁的老令牌——有主，只是认不出。绝不能当「没主」让下一个登录的人领走
  if (fs.existsSync(path.join(dir, 待认文件名))) return 认不出的主;
  return null;
}

/** 账号 id → 目录名。和 desktop/accounts.js 的 key() 是同一个算法（tests/r2-shell-accounts.test.ts 钉着） */
function 账号key(accountId: string): string {
  return crypto.createHash("sha256").update(String(accountId).trim()).digest("hex").slice(0, 24);
}

/**
 * accounts/<key> 这种按账号命名的目录：目录名本身就是归属（2026-10-04 修 B-2 / D-023）。
 * 它只会由壳的 认领() 建出来、名字就是 key(主人)；.owner 被清空（磁盘满、杀毒软件）时原来当「没主」，
 * 甲退出、乙登录就被记成乙、乙进了甲的库。拿目录名兜底就不会认错。_未认领 不是这种目录。
 */
function 目录名key(): string | null {
  const dir = process.env.CRM_DATA_DIR;
  if (!dir) return null;
  const 名 = path.basename(path.resolve(dir));
  return path.basename(path.dirname(path.resolve(dir))) === "accounts" && /^[0-9a-f]{24}$/.test(名) ? 名 : null;
}

/** 这个目录的主人（按 key 算，判「换没换人」只拿它比）。null = 没主 */
function 本目录主key(): string | null {
  const 名 = 目录名key();
  if (名) return 名;
  const v = 本目录归谁();
  return v ? 账号key(v) : null;
}

type 老令牌 = { baseUrl: string; token: string; accountId?: string };

function 读待认(): 老令牌 | null {
  const dir = process.env.CRM_DATA_DIR;
  if (!dir) return null;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, 待认文件名), "utf8")) as Partial<老令牌>;
    return typeof c.token === "string" && c.token && typeof c.baseUrl === "string" && c.baseUrl ? (c as 老令牌) : null;
  } catch {
    return null;
  }
}

/** 存不下（磁盘满）返回 false：调用方退一步记成「认不出」，宁可这份谁也领不走，也不能让凭据就这么没了 */
function 存待认(c: 老令牌): boolean {
  const dir = process.env.CRM_DATA_DIR;
  if (!dir) return false;
  try {
    fs.writeFileSync(path.join(dir, 待认文件名), JSON.stringify({ baseUrl: c.baseUrl, token: c.token }), { mode: 0o600 });
    return true;
  } catch (e) {
    console.error("[desktop] 存待认的老令牌失败：", e instanceof Error ? e.message : e);
    return false;
  }
}

function 清待认() {
  const dir = process.env.CRM_DATA_DIR;
  if (!dir) return;
  try {
    fs.rmSync(path.join(dir, 待认文件名), { force: true });
  } catch {
    /* 本来就没有 */
  }
}

/**
 * 拿一枚令牌问云端它是谁（网关 credits 接口顺带回 accountId，壳的 校验() 也靠这个）。
 * 三种回答要分清：是谁 / 已作废（401，谁的再也问不出来）/ 问不到（断网、超时、5xx）。
 */
async function 问令牌是谁(c: 老令牌): Promise<{ id: string } | { 作废: true } | { 问不到: true }> {
  const r = await 请求<{ accountId?: unknown }>(`${c.baseUrl}/api/gateway/v1/credits`, { headers: { Authorization: `Bearer ${c.token}` } }, 5_000);
  if (r.ok) return typeof r.data?.accountId === "string" && r.data.accountId ? { id: r.data.accountId } : { 问不到: true };
  return r.状态 === 401 ? { 作废: true } : { 问不到: true };
}

/** 邮箱规整成可比的样子：小写、去空格。不带 @ 的（种子库里的 "admin"）不算可比 */
const 规整邮箱 = (v: unknown) => String(v ?? "").trim().toLowerCase();
const 可比邮箱 = (v: unknown) => {
  const e = 规整邮箱(v);
  return e.includes("@") ? e : null;
};

/**
 * 「主人是邮箱为 X 的那个人」的记号（2026-10-04 修 剩余风险 1）。写进 .owner，以「?」开头所以对不上任何账号 id；
 * 邮箱取哈希，不把原文落进 .owner。和 desktop/accounts.js 的 邮箱记号() 同一个算法（tests/r2-shell-accounts.test.ts 钉着）。
 */
export const 邮箱记号 = (contact: string) => `?邮箱:${账号key(规整邮箱(contact))}`;

/**
 * 读本机库里「我」那个管理员的 email。desktop/server-entry.js 每次启动都把它对成 .cloud.json 的 contact
 * （0.39.2 之前的老版本也这么对），所以它是「这份库是谁在用」的旁证；新库是种子里的 "admin"。
 * 动态 import：这个模块被很多地方引用，别让它们都背上 prisma。测试用 设库里我的邮箱读法() 换掉。
 */
let 库里我的邮箱 = async (): Promise<string | null> => {
  try {
    const [{ prisma }, { 本机我 }] = await Promise.all([import("@/lib/prisma"), import("./me")]);
    const 我 = await 本机我(prisma);
    if (!我) return null;
    return (await prisma.user.findUnique({ where: { id: 我.id }, select: { email: true } }))?.email ?? null;
  } catch (e) {
    console.error("[desktop] 读不出本机库的管理员邮箱：", e instanceof Error ? e.message : e);
    return null;
  }
};
export function 设库里我的邮箱读法(fn: () => Promise<string | null>) {
  库里我的邮箱 = fn;
}

/** 待认的那枚老令牌认出主了：补上退出时没吊成的那一下吊销，文件清掉 */
async function 收拾待认() {
  const 待认 = 读待认();
  if (!待认) return;
  await 请求(`${待认.baseUrl}/api/account/token`, { method: "DELETE", headers: { Authorization: `Bearer ${待认.token}` } }).catch(() => null);
  清待认();
}

/**
 * 登录前定下这个目录到底归谁（2026-10-04 修 A-2 / D-021，剩余风险 1）。
 *
 * 「没有 .owner」原来一律当没主、谁登录就归谁。但 0.39.2 之前升级上来的那份（_未认领），
 * 老 .cloud.json 里没有 accountId，要等开机那次校验在 5 秒内问到云端才认领——断网 / 网慢开机就没问到，
 * 它就一直没主。这期间甲退出、乙登录，乙就被记成了主人、直接进了甲的库。
 *
 * 认人按这个次序，**宁可乙进一个新的空目录，也不许进别人的库**：
 *   1. 手上有老令牌（还在 .cloud.json 里的、或者退出时挪去待认的那枚）：当场拿它问云端是谁（A-2）
 *   2. 问不出来（作废了 / 问不到），或者根本没有老令牌——老令牌开机校验时已被吊销、壳按 401 清掉了
 *      （甲在网页上改了密码）：看库里管理员的邮箱。登录者的 contact 对得上才算他的；对不上记成「主人是那个邮箱」，
 *      算换了账号。甲改了密码回来 contact 没变，照样拿得回（剩余风险 1）
 *   3. 库里也没有可比的邮箱（从没登录过的老库、第一次装好）：有过老令牌就记「认不出」，没有才算真没主
 */
async function 定下本目录归属(登录者: { id?: string; contact: string }): Promise<string | null> {
  const 已记 = 本目录归谁();
  // 记着的是一个真账号：就是它。以「?」开头的（认不出、邮箱记号）还要往下认
  if (已记 && !已记.startsWith("?")) return 已记;
  const 待认 = 读待认();
  const 老 = 待认 ?? (已记 ? null : 读());
  let 老令牌作废 = false;
  if (老) {
    const 答 = 老.accountId ? { id: 老.accountId } : await 问令牌是谁(老);
    if ("id" in 答) {
      记本目录归属(答.id);
      await 收拾待认();
      return 答.id;
    }
    if ("作废" in 答) {
      // 令牌作废了，它是谁的再也问不出来；待认那份也没用了
      老令牌作废 = true;
      清待认();
    } else if (!待认) {
      // 问不到：老令牌留作凭据（它马上要被新令牌盖掉），下次再问。存不下就只能靠下面的邮箱 / 认不出
      存待认(老);
    }
  }
  const 他是 = 登录者.id && 可比邮箱(登录者.contact) ? 登录者.id : null;
  if (已记?.startsWith("?邮箱:")) {
    if (他是 && 已记 === 邮箱记号(登录者.contact)) {
      记本目录归属(他是);
      await 收拾待认();
      return 他是;
    }
    return 已记;
  }
  const 库里的 = 可比邮箱(await 库里我的邮箱());
  if (库里的) {
    if (他是 && 规整邮箱(登录者.contact) === 库里的) {
      记本目录归属(他是);
      await 收拾待认();
      return 他是;
    }
    记本目录归属(邮箱记号(库里的));
    return 邮箱记号(库里的);
  }
  if (老令牌作废 || (老 && !读待认())) {
    // 有过老令牌、库里又认不出人：这份数据原地留着，谁也领不走
    记本目录归属(认不出的主);
    return 认不出的主;
  }
  if (老) return 认不出的主; // 待认还在（本目录归谁 也会这么答），下次登录再问
  return 已记;
}

/**
 * 这个数据目录的归属，和手上这枚令牌**对不上**——换了账号，而壳还没把目录切过来。
 *
 * 这一刻进程连着的是**上一个账号的库**：一个字都不能给看，也不能签会话。
 * 2026-09-20 报的 bug 就是这个：在页面上换了账号登录，看到的还是上一个账号的客户。
 * 那时「换目录」全靠登录页喊一声 shell:switch-account，而桥不在时（浏览器里打开的、
 * 壳的桥没挂上）那一声就没人接，页面悄悄落到 /dashboard；/login 见还有令牌又会
 * 自动登录回来，于是乙一路进了甲的库，一声不响。
 *
 * 现在这件事不靠页面配合：**壳自己盯着这个文件换目录**（desktop/main.js 的
 * 看凭据换没换），而服务端这一份是那之前的闸——换目录、重起服务之后自然就对上了。
 *
 * 两头少一样就不算对不上：
 *   没有 .owner        —— 未认领的那份（第一次装、0.39.2 之前升级上来的），谁登录就归谁
 *                         （升级上来的那份留着老令牌时不算没主，见 定下本目录归属，A-2）
 *   令牌里没有 accountId —— 0.39.2 之前写下的那份，壳启动校验那一下会从云端补回来
 */
export function 归属对不上(): boolean {
  if (!本地模式()) return false;
  const 主 = 本目录主key();
  const id = 读()?.accountId;
  return Boolean(主 && id && 主 !== 账号key(id));
}

export function 读(): 云端凭据 | null {
  if (!本地模式()) return null;
  try {
    const c = JSON.parse(fs.readFileSync(文件(), "utf8")) as Partial<云端凭据> & { models?: unknown };
    /*
      文件要能用才算登录着（第二轮 AI）：没有令牌或没有地址（被截掉一半但还是合法 JSON）都当没登录——
      原来缺地址时拼出「undefined/api/gateway/v1」，点 AI 说「检查网络」，其实该重新登录。
      models 规整成字符串：手改过 / 别的版本写成 {id, note} 的，原来读配置就抛 TypeError，所有页面的布局跟着崩
    */
    if (typeof c.token !== "string" || !c.token || typeof c.baseUrl !== "string" || !c.baseUrl) return null;
    const models = Array.isArray(c.models)
      ? c.models
          .map((m) => (typeof m === "string" ? m : m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string" ? [(m as { id: string }).id, (m as { note?: unknown }).note].filter((x) => typeof x === "string" && x).join("|") : ""))
          .filter(Boolean)
      : [];
    return { ...(c as 云端凭据), models };
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

/**
 * 这台机器的标识：硬件 UUID 加盐 sha256 的那 64 位十六进制。
 *
 * 不在这儿算——算它要跑 `ioreg` / 读注册表，那是壳的活。壳启动本地服务时把算好的值
 * 放进环境变量（desktop/machine.js 算，desktop/main.js 传），这里只负责取和校验。
 * 进程启动时读一次就够：这个值在同一台机器上不会变（重装系统才变）。
 *
 * 取不到（老壳、非桌面端、硬件 UUID 读不出来）就是 null，登录时那个字段干脆不带。
 * 服务端那边「不知道是哪台机器」= **不发注册赠送**，不是照发——
 * 详见 lib/tenant/credits.ts 的文件头。所以这里宁可返回 null，
 * **也绝不能自己编一个**（随机值、机器名的哈希、存在本地文件里的 id 都算编）：
 * 编出来的东西要么每次启动都不一样（那就是「每次都是一台新电脑」，白送），
 * 要么删个文件就能换一个（那就是「清 cookie 换额度」），两种都比诚实地承认取不到糟。
 */
export function 机器哈希(): string | null {
  const v = (process.env.CRM_MACHINE_HASH ?? "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(v) ? v : null;
}

type 结果<T = unknown> = { ok: true; data: T } | { ok: false; error: string; 状态?: number };

/**
 * 连不上要当一个**结果**回去，不能让它抛出去：断网点登录，按钮一直转、一个字的提示都没有，
 * 看起来就是点了没反应。状态码也带回去——调用方要分得清「服务端明确拒了」和「根本没问到」。
 */
/**
 * 这台装的是什么：系统、芯片、版本号——和壳（desktop/cloud.js 的 客户端头）报的是同一组。
 * 版本号是壳启动时写进环境变量的 CRM_APP_VERSION，本地服务作为子进程继承下来。
 */
function 客户端头(): Record<string, string> {
  const h: Record<string, string> = { "X-Client-Platform": process.platform, "X-Client-Arch": process.arch };
  if (process.env.CRM_APP_VERSION) h["X-Client-Version"] = process.env.CRM_APP_VERSION;
  return h;
}

async function 请求<T = unknown>(url: string, init: RequestInit = {}, 超时毫秒 = 20_000): Promise<结果<T>> {
  let res: Response;
  try {
    const headers = { ...客户端头(), ...Object.fromEntries(new Headers(init.headers).entries()) };
    res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(超时毫秒), cache: "no-store" });
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
export async function 策略(): Promise<{ register: boolean; reset: boolean; inApp: boolean }> {
  // 短超时：这一问挡在登录页渲染前面，断网时不能让人对着空白页等 20 秒
  const r = await 请求<{ register?: boolean; reset?: boolean; inApp?: boolean }>(`${云端地址()}/api/account/policy`, {}, 5_000);
  if (!r.ok) return { register: false, reset: false, inApp: false };
  /* inApp：云端有没有 /api/account/signup/*（2026-10-02 加）。没有就照旧开浏览器去网页注册 */
  return { register: Boolean(r.data?.register), reset: Boolean(r.data?.reset), inApp: Boolean(r.data?.inApp) };
}

type 登录响应 = { token?: string; account?: { id?: string; name?: string; contact?: string }; credits?: { 还剩?: number } };

/** 登录：账号密码换一枚长期设备令牌，顺手把可用模型拉下来，一起写进 .cloud.json */
export async function 登录(target: string, password: string): Promise<结果<{ name: string; contact: string; 还剩?: number; 换了账号: boolean }>> {
  const 拒 = 拒绝非本地();
  if (拒) return 拒;
  /*
    登录**之前**先看这个目录现在归谁。写完 .cloud.json 就看不出来了，
    而调用方必须知道这次是不是换了人：数据目录一个账号一份（desktop/accounts.js），
    换了人就得让壳去换目录、重起本地服务，**在那之前一个字都不能往本机库里写**——
    这会儿连着的还是上一个人的库。
  */
  const 云 = 云端地址();
  /*
    `machine` 是这台电脑的标识（加盐 sha256 的硬件 UUID）。云端拿它做一件事：
    **注册赠送的那 30 次一台机器只发一次**——同一台电脑上注册第二个账号不再另送一份。
    取不到就整个字段不带（`undefined` 不会出现在 JSON 里），云端据此不发注册赠送、
    只发每日的那几次；见 机器哈希() 上面那段和 lib/tenant/credits.ts。
  */
  const r = await 请求<登录响应>(`${云}/api/account/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, password, name: 设备名(), machine: 机器哈希() ?? undefined }),
  });
  if (!r.ok) return r;
  const token = r.data?.token;
  if (!token) return { ok: false, error: "服务器没有返回令牌" };

  // 模型列表是首页那个选单——用户不用知道我们在后面接的是哪家。拉不到就空着，AI 仍然可用
  const m = await 请求<{ data?: { id: string; note?: string }[] }>(`${云}/api/gateway/v1/models`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const models = m.ok ? (m.data?.data ?? []).map((x) => (x.note ? `${x.id}|${x.note}` : x.id)).filter(Boolean) : [];

  /*
    必须赶在 写(c) 之前：没主的目录里那枚老令牌（A-2）一会儿就被新令牌盖掉，盖掉就再也问不出这份是谁的了。
    放在账号密码验过之后：密码错的那一下不该有任何动静（目录、归属、指针都不动）
  */
  const 名key = 目录名key();
  // 按账号命名的目录认目录名，不用去问（B-2）；只有 _未认领 这种才要定归属（A-2）
  const 旧归谁 = 名key ? null : await 定下本目录归属({ id: r.data?.account?.id, contact: r.data?.account?.contact || target });
  const 旧主key = 名key ?? (旧归谁 ? 账号key(旧归谁) : null);

  const c: 云端凭据 = {
    baseUrl: 云,
    token,
    accountId: r.data?.account?.id,
    name: r.data?.account?.name ?? "",
    contact: r.data?.account?.contact ?? "",
    models,
    loggedAt: new Date().toISOString(),
  };
  写(c);
  /*
    目录上没有归属标记就当没换人：那是未认领的那一份（第一次装应用，
    或者 0.39.2 之前升级上来的），本来就在等人认领，认领的正是他。

    **当场把归属记下来**（2026-10-02 排查桌面端 A2）。原来要等「带着令牌重启」那一下才记：
    第一次装好、甲登录录了客户、退出，乙再登录——目录还是没主的，于是判「没换人」，乙直接进了甲的库，
    下次启动还把这份整个认领走。现在甲一登录这份就归甲；乙登录时对不上，壳把他换到自己的目录。
    只写记号不改目录名：改名要重起本地服务，那是壳在启动时做的事（desktop/accounts.js 认领）。
  */
  if (!旧主key && c.accountId) 记本目录归属(c.accountId);
  const 换了账号 = !!(旧主key && c.accountId && 旧主key !== 账号key(c.accountId));
  // 同一个人回来、而 .owner 坏了 / 空了（B-2）：顺手补回去
  if (旧主key && c.accountId && !换了账号 && 本目录归谁() !== c.accountId) 记本目录归属(c.accountId);
  return { ok: true, data: { name: c.name, contact: c.contact, 还剩: r.data?.credits?.还剩, 换了账号 } };
}

/**
 * 退出。先让服务端把令牌吊销掉——只删本地文件的话，令牌还在库里有效，
 * 谁抄走过它就一直能用我们的额度。吊不掉（断网）也照删本地那份：人要退，不能拦。
 */
export async function 退出(): Promise<void> {
  const c = 读();
  if (c) {
    /*
      没主的目录上退出（2026-10-04 修 A-2 / D-021）：令牌一删，「这份有主」的唯一凭据就没了，下一个登录的人会被记成主人。
      所以删之前先把主定下来——令牌里有 accountId 就用它，没有（0.39.2 之前写的）就问云端；
      问不到（断网 / 网慢）就**先不吊销**，把令牌挪去待认、留作凭据，等下一次登录（那时一定连得上）再问再吊。
      多留一阵的这枚令牌和原来 .cloud.json 一样 0600、躺在同一个目录里，不比退出前更外露。
    */
    if (!本目录主key()) {
      const 答 = c.accountId ? { id: c.accountId } : await 问令牌是谁(c);
      if ("id" in 答) 记本目录归属(答.id);
      else if ("作废" in 答) 记本目录归属(认不出的主);
      else if (存待认(c)) {
        清();
        return;
      } else 记本目录归属(认不出的主);
    }
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
/**
 * 应用里注册的第一步：填了邮箱点「继续」。云端回答往哪走——
 * 已注册（去输密码）、码已发出（去输验证码）、不用验证码（直接设密码）。规则见 api/account/signup/start。
 */
export type 注册去向 = { 去: "密码" } | { 去: "验证码"; hint?: string } | { 去: "设密码" };
export async function 注册开始(target: string): Promise<结果<注册去向>> {
  const 拒 = 拒绝非本地();
  if (拒) return 拒;
  const r = await 请求<{ verify?: boolean; hint?: string; registered?: boolean }>(`${云端地址()}/api/account/signup/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
  // 409 已注册 → 输密码；404 是还没这个接口的老云端（H-055）→ 退回旧版，也去输密码（登录接口老云端一直有）
  if (!r.ok) return r.状态 === 409 || r.状态 === 404 ? { ok: true, data: { 去: "密码" } } : r;
  return { ok: true, data: r.data?.verify ? { 去: "验证码", hint: r.data.hint } : { 去: "设密码" } };
}

/**
 * 输码那一步填满 6 位先核对（2026-10-03，云端 /api/account/code/check）。错了当场抖，不用等到最后一步。
 * **核对不了不拦人**：老版本云端没有这个接口（404）、断网、超时，一律当「先往下走」——
 * 最后那一步云端还会再验一次，这里只是把「码不对」提前说，不是第二道闸
 */
export async function 核对验证码(target: string, code: string, purpose: "signup" | "reset"): Promise<{ 对: boolean; error?: string }> {
  const 拒 = 拒绝非本地();
  if (拒) return { 对: true };
  const r = await 请求(`${云端地址()}/api/account/code/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, code, purpose }),
  }, 8_000);
  if (r.ok) return { 对: true };
  return r.状态 === 400 ? { 对: false, error: r.error } : { 对: true };
}

/** 开账号。只开不登：调用方紧接着拿同一套邮箱密码走 登录()，注册赠送在那一下按机器结算 */
export async function 注册(input: { target: string; code?: string; password: string; agreed: boolean }): Promise<结果> {
  const 拒 = 拒绝非本地();
  if (拒) return 拒;
  return 请求(`${云端地址()}/api/account/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function 重置密码(input: { target: string; code: string; password: string }): Promise<结果> {
  const 拒 = 拒绝非本地();
  if (拒) return 拒;
  return 请求(`${云端地址()}/api/account/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export type 余额信息 = { 上限: number; 用掉: number; 还剩: number; 每日赠送?: number; 每日赠送截至?: string | null };

/** 还剩几次。问不到（断网）就是 null，设置页据此写「查不到」，不能把整页拖垮 */
export async function 余额(): Promise<余额信息 | null> {
  const c = 读();
  if (!c) return null;
  const r = await 请求<余额信息>(`${c.baseUrl}/api/gateway/v1/credits`, { headers: { Authorization: `Bearer ${c.token}` } });
  if (r.ok && typeof r.data?.还剩 === "number") 记AI余额({ baseUrl: `${c.baseUrl}/api/gateway/v1`, apiKey: c.token }, r.data.还剩);
  return r.ok ? r.data : null;
}

/**
 * 交给 llm.ts 的 AI 配置：那枚令牌就是 Key，网关就是接口地址。
 * 没登录返回 null——那时 AI 入口整个隐藏，CRM 其余功能照常，和自部署版没配 Key 时一样。
 * 每次调用都重新读文件：登录、退出要**即时**生效，不能像环境变量那样要重启服务才换。
 */
/**
 * 模型列表过一阵就重拉一次（2026-10-02 排查桌面端 D2）。原来只在登录那一刻拉、存进 .cloud.json 后再不动：
 * 网关一改白名单，选单里就只剩下线的那几个，要退出重登才好。网关那头对白名单外的已经改成换默认模型（不再 400），
 * 这里管的是选单别一直摆着用不了的名字。后台拉、不挡这一次调用；拉不到就留着旧的。
 */
const 模型刷新记录 = new Map<string, { 成功: number; 尝试: number; 在途: boolean }>();
const 拉模型间隔 = 6 * 3600_000;
const 拉模型失败退避 = 30_000;
async function 刷新模型(c: 云端凭据): Promise<boolean> {
  const m = await 请求<{ data?: { id: string; note?: string }[] }>(`${c.baseUrl}/api/gateway/v1/models`, {
    headers: { Authorization: `Bearer ${c.token}` },
  });
  if (!m.ok || !Array.isArray(m.data?.data)) return false;
  const models = m.data.data.filter((x) => x && typeof x.id === "string" && x.id.trim())
    .map((x) => (typeof x.note === "string" && x.note ? `${x.id}|${x.note}` : x.id));
  const 现在的 = 读();
  // 拉的这会儿换了账号 / 退出了：不往别人的凭据里写
  if (!models.length || !现在的 || 现在的.token !== c.token || 现在的.baseUrl !== c.baseUrl) return false;
  if (JSON.stringify(现在的.models) !== JSON.stringify(models)) 写({ ...现在的, models });
  return true;
}

export function 模型配置(): { apiKey: string; baseUrl: string; account: string; models: string[] } | null {
  const c = 读();
  if (!c) return null;
  const key = crypto.createHash("sha256").update(`${c.baseUrl}|${c.token}`).digest("hex");
  const state = 模型刷新记录.get(key) ?? { 成功: 0, 尝试: 0, 在途: false };
  const now = Date.now();
  if (!state.在途 && (!state.成功 || now - state.成功 >= 拉模型间隔) && (!state.尝试 || now - state.尝试 >= 拉模型失败退避)) {
    state.尝试 = now; state.在途 = true;
    if (模型刷新记录.size >= 128 && !模型刷新记录.has(key)) 模型刷新记录.clear();
    模型刷新记录.set(key, state);
    void 刷新模型(c).then((ok) => { if (ok) state.成功 = Date.now(); }).catch(() => {}).finally(() => { state.在途 = false; });
  }
  return {
    apiKey: c.token,
    baseUrl: `${c.baseUrl}/api/gateway/v1`,
    account: c.contact || c.name || "已登录",
    models: c.models?.length ? c.models : [],
  };
}
