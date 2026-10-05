/**
 * 团队同步的桌面端这一头（2026-10-03，0.46.15 第 5 块）：建团队、凭邀请码加入、同步一轮（先推后拉）、退出。
 *
 * 团队的东西记在 `$CRM_DATA_DIR/.team.json`（0600，和 .cloud.json 一个做法）：团队编号、入队口令、**钥匙**、本机设备编号。
 * 钥匙只在这里和邀请码里，我们的服务器见不到。丢了钥匙：云上密文作废，但每个人电脑上都有全量，任何一个人重建团队即可。
 *
 * 只在桌面端本地模式、登录了云端账号时能用。和云端说话用那枚设备令牌（.cloud.json 里的 dk_…）。
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { prisma } from "../prisma";
import { 本地模式, 读 as 读云端凭据, 云端地址 } from "../desktop/cloud";
import { 团队身份id } from "../desktop/me";
import { 改身份, 建同步表, 装触发器, 卸触发器, 记全量, 待推, 记已推, 回放, 装了吗, 只留自己的, 没同步上, 本机结构签名, type 改动 } from "./local";
import { 封, 拆, 新钥匙, 设备钥匙对, 封给, 拆自, 签名钥匙对, 签上, 验, type 钥匙环 } from "./crypto";
import { 看全部, 忘掉限定, 在同步里 } from "../team-scope";
import { invalidateSettingsCache } from "../settings";

export type 团队配置 = {
  teamId: string;
  teamName: string;
  joinSecret: string;
  key: string;
  /** 现在这把钥匙是第几把（没换过 = 0）。见 lib/sync/crypto.ts 换钥匙 */
  epoch?: number;
  /** 之前的钥匙：编号 → 钥匙。解老批次用 */
  keys?: 钥匙环;
  device: string;
  /** 这台设备的钥匙对：换钥匙时建团队的人用公钥给我封新钥匙，私钥只在这里 */
  devPub?: string;
  devPriv?: string;
  /** 老板的签名公钥（邀请码 DT2 里带来的）：新钥匙只认带这个签名的（复查中 1）。DT1 时代进来的没有，不验 */
  signPub?: string;
  /** 老板那台才有：签信封和钥匙环用 */
  signPriv?: string;
  /**
   * 上一次中转名单说的老板（建团队的人）是哪个云端账号。被移出之后名单里就没有这个团了、也可能连不上云端，
   * 退出时判「我是不是业务员」靠它，不靠本机 User.role（2026-10-04 T-041）
   */
  ownerAccountId?: string;
  /** 解不开的批次：序号 → 试了几次。连着 3 次解不开就跳过、记下（复查低 4：一批坏包不许卡死这台） */
  bad?: Record<string, number>;
  skipped?: number[];
  /** 拉到第几批了 */
  pulled: number;
  /** 上一次拉完时本机的表结构签名（local.ts 本机结构签名）。变了 = 升级过、多了能收的表 / 列，从头重拉 */
  结构?: string;
  lastSyncAt?: string;
  lastError?: string | null;
  /** 上一轮做了什么，给界面那一行说话 */
  last?: { 推: number; 拉: number; 撞: number };
};

type 结果<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function 配置文件(): string {
  const dir = process.env.CRM_DATA_DIR;
  if (!dir) throw new Error("没有 CRM_DATA_DIR");
  return path.join(dir, ".team.json");
}
export function 读团队(): 团队配置 | null {
  try {
    const c = JSON.parse(fs.readFileSync(配置文件(), "utf8")) as 团队配置;
    return c.teamId && c.key && c.device ? c : null;
  } catch {
    return null;
  }
}
/** 先写临时文件再改名（写到一半断电不会留下半个 .team.json），权限每次都收紧到 0600（复查低 8） */
function 写团队(c: 团队配置) {
  const f = 配置文件();
  const 临 = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(临, JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.chmodSync(临, 0o600);
  fs.renameSync(临, f);
}

/* ---------------- 和云端说话：默认走 HTTP，测试里换成直接调中转 ---------------- */
export type 传输 = (方法: "GET" | "POST", 路径: string, body?: unknown) => Promise<{ 状态: number; json: Record<string, unknown> }>;
const HTTP: 传输 = async (方法, 路径, body) => {
  const c = 读云端凭据();
  if (!c) return { 状态: 401, json: { error: "还没登录云端账号" } };
  try {
    const r = await fetch(`${云端地址()}${路径}`, {
      method: 方法,
      headers: { Authorization: `Bearer ${c.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    return { 状态: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { 状态: 0, json: { error: "连不上云端，检查一下网络" } };
  }
};
let 云: 传输 = HTTP;
/** 测试用：换掉和云端说话的方式 */
export function 设传输(t: 传输 | null) {
  云 = t ?? HTTP;
}

/** 本机手上的全部钥匙（之前的 + 现在这把） */
const 全部钥匙 = (c: 团队配置): 钥匙环 => ({ ...(c.keys ?? {}), [String(c.epoch ?? 0)]: c.key });

/* ---------------- 邀请码：团队编号 + 入队口令 + 钥匙（+ 老板的签名公钥） ---------------- */
/** DT2 = DT1 + 老板的签名公钥。有签名公钥就出 DT2 */
export const 邀请码 = (c: Pick<团队配置, "teamId" | "joinSecret" | "key" | "signPub">) =>
  c.signPub ? `DT2.${c.teamId}.${c.joinSecret}.${c.key}.${c.signPub}` : `DT1.${c.teamId}.${c.joinSecret}.${c.key}`;
export function 解邀请码(s: string): { teamId: string; joinSecret: string; key: string; signPub?: string } | null {
  const t = String(s ?? "").trim();
  const m2 = /^DT2\.([a-z0-9]+)\.([\w-]+)\.([\w-]{43})\.([\w-]{43})$/i.exec(t);
  if (m2) return { teamId: m2[1], joinSecret: m2[2], key: m2[3], signPub: m2[4] };
  const m = /^DT1\.([a-z0-9]+)\.([\w-]+)\.([\w-]{43})$/i.exec(t);
  return m ? { teamId: m[1], joinSecret: m[2], key: m[3] } : null;
}

/** 钥匙环、信封签名时的「用途」：绑上团队、编号（信封还有设备），挪不到别的团队 / 别的编号上用 */
const 环用途 = (teamId: string, epoch: number) => `ring|${teamId}|${epoch}`;
const 信用途 = (teamId: string, epoch: number, device: string) => `env|${teamId}|${epoch}|${device}`;
const 环绑定 = (teamId: string) => ({ teamId, device: "ring" });

/** 有签名公钥就必须验得过；没有（DT1 时代进来的）原样用 */
function 验过(签好: string, 用途: string, signPub: string | undefined): string {
  if (!signPub) return 签好;
  const 原 = 验(签好, 用途, signPub);
  if (原 == null) throw new 同步问题("收到的团队钥匙没有老板的签名，可能有人冒充：这次没收下。请联系我们，先别在这台电脑上同步");
  return 原;
}

function 能用(): 结果<{ accountId: string; contact: string; name: string }> {
  if (!本地模式()) return { ok: false, error: "团队同步只在桌面端用" };
  const c = 读云端凭据();
  if (!c?.accountId) return { ok: false, error: "先登录云端账号" };
  return { ok: true, accountId: c.accountId, contact: c.contact, name: c.name };
}

/**
 * 本机开同步：改身份（必须在装触发器之前）→ 建表 → 装触发器 → 本机已有的整份记成新建。
 * 已经装过（重新加入另一个团队）：只换团队，不再改身份、不再记全量——日志里已经有了
 */
async function 本机开同步(我: { accountId: string; contact: string; name: string }, 加入别人的: boolean) {
  if (await 装了吗(prisma)) return;
  await 改身份(prisma, 团队身份id(我.accountId), { email: 我.contact, name: 我.name || 我.contact.split("@")[0] });
  await 建同步表(prisma);
  await 装触发器(prisma);
  // 加入别人团队的不推业务配置：团队的模版、币种以建团队的人为准（见 记全量）
  await 记全量(prisma, { 不含设置: 加入别人的 });
}

export function 建团队(名字: string): Promise<结果<{ 邀请码: string }>> {
  return 看全部(() => 建团队里(名字));
}
async function 建团队里(名字: string): Promise<结果<{ 邀请码: string }>> {
  const 我 = 能用();
  if (!我.ok) return 我;
  if (读团队()) return { ok: false, error: "这台电脑已经在一个团队里了，先退出" };
  const 设备 = `d${randomBytes(6).toString("hex")}`;
  const 对 = 设备钥匙对();
  const 签 = 签名钥匙对();
  const r = await 云("POST", "/api/sync/team", { name: 名字, device: 设备, pubKey: 对.公钥 });
  if (r.状态 !== 200 || !r.json.teamId) return { ok: false, error: String(r.json.error ?? "建不了团队") };
  await 本机开同步(我, false);
  const c: 团队配置 = { teamId: String(r.json.teamId), teamName: 名字.trim(), joinSecret: String(r.json.joinSecret), key: 新钥匙(), epoch: 0, keys: {}, device: 设备, devPub: 对.公钥, devPriv: 对.私钥, signPub: 签.公钥, signPriv: 签.私钥, ownerAccountId: 我.accountId, pulled: 0, lastError: null };
  写团队(c);
  return { ok: true, 邀请码: 邀请码(c) };
}

export function 加入团队(码: string): Promise<结果<{ teamName: string; active: boolean }>> {
  return 看全部(() => 加入团队里(码));
}
async function 加入团队里(码: string): Promise<结果<{ teamName: string; active: boolean }>> {
  const 我 = 能用();
  if (!我.ok) return 我;
  const 解 = 解邀请码(码);
  if (!解) return { ok: false, error: "邀请码不对：要整段复制，从 DT2.（或 DT1.）开头" };
  const 现 = 读团队();
  // 已经在这个团队里、粘的是建团队的人换过的新邀请码：只换钥匙（这台没拿到自动转交的新钥匙时走这条）
  if (现 && 现.teamId === 解.teamId) {
    // 同一个团队的签名公钥不会变：码里的和本机记着的对不上，不收（换了签名公钥 = 有人冒充）
    if (现.signPub && 解.signPub !== 现.signPub) return { ok: false, error: "这个邀请码和团队对不上（老板的签名不一样），找老板重新要一个" };
    const k = await 收下码里的钥匙(现.teamId, 现.device, 解.key, 现.signPub ?? 解.signPub);
    if (!k.ok) return k;
    写团队({ ...现, joinSecret: 解.joinSecret, key: 解.key, epoch: k.epoch, keys: k.keys, signPub: 现.signPub ?? 解.signPub, lastError: null });
    return { ok: true, teamName: 现.teamName, active: true };
  }
  if (现) return { ok: false, error: "这台电脑已经在一个团队里了，先退出" };
  const 设备 = `d${randomBytes(6).toString("hex")}`;
  const 对 = 设备钥匙对();
  const r = await 云("POST", "/api/sync/join", { teamId: 解.teamId, joinSecret: 解.joinSecret, device: 设备, pubKey: 对.公钥 });
  if (r.状态 !== 200) return { ok: false, error: String(r.json.error ?? "加入不了") };
  const k = await 收下码里的钥匙(解.teamId, 设备, 解.key, 解.signPub);
  if (!k.ok) return k;
  await 本机开同步(我, true);
  写团队({ ...解, teamName: String(r.json.teamName ?? ""), epoch: k.epoch, keys: k.keys, device: 设备, devPub: 对.公钥, devPriv: 对.私钥, pulled: 0, lastError: null });
  // 加入别人的团队 = 业务员（老板是建团队的人）。先按名单对一次：不等第一轮同步，界面马上就是业务员的样子
  await 对齐角色().catch(() => undefined);
  return { ok: true, teamName: String(r.json.teamName ?? ""), active: !!r.json.active };
}

/**
 * 邀请码里的钥匙是团队现在那把：问云端现在第几把、取钥匙环，用码里的钥匙解开 → 之前的钥匙都有了，历史读得到。
 * 解不开 = 码里那把已经换掉了（这个码是换钥匙之前发的）
 */
async function 收下码里的钥匙(teamId: string, 设备: string, 码钥匙: string, signPub?: string): Promise<结果<{ epoch: number; keys: 钥匙环 }>> {
  const r = await 云("GET", `/api/sync/key?teamId=${encodeURIComponent(teamId)}&device=${encodeURIComponent(设备)}`);
  if (r.状态 !== 200) return { ok: false, error: String(r.json.error ?? "取不到团队钥匙") };
  const epoch = Number(r.json.epoch ?? 0);
  if (!epoch) return { ok: true, epoch: 0, keys: {} };
  let 环: string;
  try {
    环 = 验过(String(r.json.ring ?? ""), 环用途(teamId, epoch), signPub);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  try {
    return { ok: true, epoch, keys: 拆<{ keys: 钥匙环 }>(环, 码钥匙, 环绑定(teamId)).keys };
  } catch {
    return { ok: false, error: "这个邀请码已经作废了（团队换过钥匙），找老板要一个新的" };
  }
}

/**
 * 团队换过钥匙了：取封给这台设备的那一份，用本机私钥解开，再解开钥匙环拿到之前的钥匙。
 * 没有封给这台的（这台是换钥匙之后才登记的老版本、或者被移出了）：说清楚找老板要新邀请码。
 */
async function 更新钥匙(c: 团队配置): Promise<团队配置> {
  const r = await 云("GET", `/api/sync/key?teamId=${encodeURIComponent(c.teamId)}&device=${encodeURIComponent(c.device)}`);
  if (r.状态 !== 200) throw new 同步问题(String(r.json.error ?? "取不到团队钥匙"));
  const epoch = Number(r.json.epoch ?? 0);
  if (epoch <= (c.epoch ?? 0)) return c;
  const 信 = r.json.envelope ? String(r.json.envelope) : null;
  if (!信 || !c.devPriv) throw new 同步问题("团队换过钥匙了，这台电脑没拿到新钥匙：找老板要新的邀请码，在「设置 → 团队」里粘贴");
  const key = 拆自(c.devPriv, 验过(信, 信用途(c.teamId, epoch, c.device), c.signPub));
  const keys = 拆<{ keys: 钥匙环 }>(验过(String(r.json.ring ?? ""), 环用途(c.teamId, epoch), c.signPub), key, 环绑定(c.teamId)).keys;
  const 新 = { ...c, key, epoch, keys };
  const 现 = 读团队();
  if (现?.teamId === c.teamId) 写团队({ ...现, key, epoch, keys });
  return 新;
}

/** 说给人听的同步问题（不是程序错）：原样显示 */
class 同步问题 extends Error {}

/**
 * 换钥匙（只有建团队的人）：新钥匙给在册的每台设备各封一份、之前的钥匙封成钥匙环，交给云端转交。
 * 移除成员、换邀请码之后都走这里：被移除的那台没有信封，之后的改动解不开；旧邀请码里的钥匙也就作废了。
 */
async function 换钥匙并换码(c: 团队配置, joinSecret: string): Promise<结果<{ 跳过: number }>> {
  // 里面的 更新钥匙 会抛「说给人听」的错：接住，别让设置页的动作变成一个白屏 500（复查低 6）
  try {
    const d = await 云("GET", `/api/sync/devices?teamId=${encodeURIComponent(c.teamId)}`);
    if (d.状态 !== 200) return { ok: false, error: String(d.json.error ?? "取不到团队的设备") };
    // 本机落后于云端（上一次换钥匙云端成了、回包丢了）：先用自己那台的信封追上
    const 追上 = Number(d.json.epoch ?? 0) > (c.epoch ?? 0) ? await 更新钥匙(c) : c;
    const epoch = Number(d.json.epoch ?? 0) + 1;
    const key = 新钥匙();
    const 之前 = 全部钥匙(追上);
    const 签 = (原: string, 用途: string) => (追上.signPriv && 追上.signPub ? 签上(原, 用途, 追上.signPriv, 追上.signPub) : 原);
    // 一台公钥坏了（乱写的、老版本的）跳过它，别让整次换钥匙失败（复查低-中 3）；它下次同步会提示要新邀请码
    let 跳过 = 0;
    const envelopes: { device: string; data: string }[] = [];
    for (const x of (d.json.devices as { device: string; pubKey: string }[]) ?? []) {
      try {
        envelopes.push({ device: x.device, data: 签(封给(x.pubKey, key), 信用途(c.teamId, epoch, x.device)) });
      } catch {
        跳过++;
      }
    }
    const ring = 签(封({ keys: 之前 }, key, epoch, 环绑定(c.teamId)), 环用途(c.teamId, epoch));
    const r = await 云("POST", "/api/sync/rotate", { teamId: c.teamId, epoch, ring, envelopes });
    if (r.状态 !== 200) return { ok: false, error: String(r.json.error ?? "钥匙没换成") };
    const 现 = 读团队();
    写团队({ ...(现 ?? 追上), joinSecret, key, epoch, keys: 之前 });
    return { ok: true, 跳过 };
  } catch (e) {
    return { ok: false, error: e instanceof 同步问题 ? e.message : `钥匙没换成：${e instanceof Error ? e.message.slice(0, 200) : String(e)}` };
  }
}

/**
 * 换口令 / 换钥匙这类老板动作，本机一次只跑一个（2026-10-04，团队端复查）：
 * 连点两次「换邀请码」，两次都去云端换口令、各自写回 .team.json，最后显示的码可能是被后一次作废的那个，新人拿着进不来。
 * 正在跑就等它跑完再开下一个；同一个动作连点，第二下直接拿第一下的结果
 */
let 老板动作: Promise<unknown> | null = null;
let 正在换码: Promise<结果<{ 邀请码: string; 跳过: number }>> | null = null;
async function 一个一个来<T>(fn: () => Promise<T>): Promise<T> {
  while (老板动作) await 老板动作.catch(() => undefined);
  const p = fn();
  老板动作 = p;
  try {
    return await p;
  } finally {
    if (老板动作 === p) 老板动作 = null;
  }
}

/**
 * 这台能不能做老板的动作（移除成员、换邀请码）：新钥匙要用老板的签名私钥签，私钥只在建团队的那台 .team.json 里。
 * 老板在另一台电脑上用邀请码进来的，手上只有公钥——在那台换出去的钥匙没签名，同事全部拒收（「可能有人冒充」），
 * 整个团队卡住（10-05 写上手说明时查出来的）。DT1 时代的团队没有签名公钥，不受这条限制
 */
export function 能管理团队(c: 团队配置): boolean {
  return !!c.signPriv || !c.signPub;
}
const 不在建团队那台 = "移除同事、换邀请码只能在建团队的那台电脑上做：老板的签名钥匙只在那台上，这台换出去的新钥匙同事会拒收";

/** 移除成员（只有建团队的人）：云端移出 + 换入队口令，本机接着换钥匙 */
export function 移除成员(accountId: string): Promise<结果> {
  return 一个一个来(() => 移除成员里(accountId));
}
async function 移除成员里(accountId: string): Promise<结果> {
  const c = 读团队();
  if (!c) return { ok: false, error: "没有加入团队" };
  // 去云端之前就挡：先移出再发现钥匙换不了，人出去了钥匙却没换，团队卡在半截
  if (!能管理团队(c)) return { ok: false, error: 不在建团队那台 };
  if (在跑) await 在跑.catch(() => undefined);
  const r = await 云("POST", "/api/sync/remove", { teamId: c.teamId, accountId });
  if (r.状态 !== 200) return { ok: false, error: String(r.json.error ?? "移除不了") };
  写团队({ ...(读团队() ?? c), joinSecret: String(r.json.joinSecret) });
  const k = await 换钥匙并换码(读团队() ?? c, String(r.json.joinSecret));
  return k.ok ? k : { ok: false, error: `人已经移出了，但钥匙没换成：${k.error}。再点一次「换邀请码」` };
}

/** 换邀请码（只有建团队的人）：旧码作废、钥匙一起换（码里带着钥匙）。已经在团队里的人自动拿到新钥匙 */
export function 换邀请码(): Promise<结果<{ 邀请码: string; 跳过: number }>> {
  // 连点：第二下直接拿第一下的结果，不再去云端换第二次
  if (!正在换码) 正在换码 = 一个一个来(换邀请码里).finally(() => { 正在换码 = null; });
  return 正在换码;
}
async function 换邀请码里(): Promise<结果<{ 邀请码: string; 跳过: number }>> {
  const c = 读团队();
  if (!c) return { ok: false, error: "没有加入团队" };
  if (!能管理团队(c)) return { ok: false, error: 不在建团队那台 };
  if (在跑) await 在跑.catch(() => undefined);
  const r = await 云("POST", "/api/sync/secret", { teamId: c.teamId });
  if (r.状态 !== 200) return { ok: false, error: String(r.json.error ?? "换不了") };
  写团队({ ...(读团队() ?? c), joinSecret: String(r.json.joinSecret) });
  const k = await 换钥匙并换码(读团队() ?? c, String(r.json.joinSecret));
  if (!k.ok) return k;
  // 带上跳过了几台（公钥坏的那几台没拿到新钥匙，下次同步会提示要新邀请码；2026-10-04 T-052 用例据此钉住逐台跳过）
  return { ok: true, 邀请码: 邀请码(读团队()!), 跳过: k.跳过 };
}

type 名单团 = { id: string; 我是建的人?: boolean; ownerAccountId?: string; 成员?: { accountId: string; role: string }[] };

/** 中转名单里这个团的老板是哪个账号（owner 那一行；老版本中转只给「我是建的人」时退回它） */
function 名单里的老板(团: 名单团, 我账号: string | undefined): string | null {
  return 团.成员?.find((m) => m.role === "owner")?.accountId ?? 团.ownerAccountId ?? (团.我是建的人 && 我账号 ? 我账号 : null);
}

/** 名单说的老板记进 .team.json：被移出 / 连不上云端时退出团队还能照它判（T-041） */
function 记下老板(teamId: string, 老板: string | null) {
  const 现 = 读团队();
  if (老板 && 现?.teamId === teamId && 现.ownerAccountId !== 老板) 写团队({ ...现, ownerAccountId: 老板 });
}

/**
 * 离开团队时要不要「只留自己的」：只有确定我是业务员才删（2026-10-04 T-041）。
 * 原来看本机 User.role：那只是按名单对出来的副本，刚加入还没对、库被人改过都会错——
 * 错成业务员，老板电脑上全队的客户就没了。所以：
 *   - 建团队的那台（手上有签名私钥）永远不删
 *   - 云端答得上来：按名单里的老板是不是我判
 *   - 答不上来（被移出后名单里没这个团了、连不上）：按上次名单记下的老板判；从没记过 = 不知道 = 不删
 * 宁可业务员电脑上多留一份，也不能删错老板的。
 */
function 走时只留自己的(c: 团队配置, 团: 名单团 | undefined, 我账号: string | undefined): boolean {
  if (!我账号 || c.signPriv) return false;
  const 老板 = (团 && 名单里的老板(团, 我账号)) || c.ownerAccountId || null;
  return !!老板 && 老板 !== 我账号;
}

/** 问一次中转名单里这个团（问不到、名单里没有都是 undefined） */
async function 名单里的团(teamId: string): Promise<名单团 | undefined> {
  const r = await 云("GET", "/api/sync/team");
  if (r.状态 !== 200) return undefined;
  return ((r.json.teams as 名单团[]) ?? []).find((t) => t.id === teamId);
}

/**
 * 退出团队：本机数据全留着，只是不再推拉；触发器卸掉（日志表留着，以后再进团队不用重记全量）。
 * 退出中不开新的一轮（2026-10-04 T-009）：原来只等了点退出那一刻在跑的那一轮，退出自己还要等云端回话，
 * 这期间壳 8 秒一戳又开一轮，那一轮的拉取在退完之后才回放——业务员「只留自己的」删掉的同事客户又被放回来，
 * 第一轮还会把刚卸的触发器重新装上。退出是一个整体，同一时间也只跑一个
 */
let 退出中: Promise<结果> | null = null;
export function 退出团队(): Promise<结果> {
  if (!退出中) 退出中 = 退出团队里().finally(() => { 退出中 = null; });
  return 退出中;
}
async function 退出团队里(): Promise<结果> {
  // 正在跑的那一轮先跑完：不然它跑到最后把 .team.json 写回来，界面上还「在团队里」、触发器却已经卸了（复查）
  while (在跑) await 在跑.catch(() => undefined);
  const c = 读团队();
  if (!c) return { ok: true };
  // 先问名单、再退队：退了之后名单里就没有这个团了，问不出谁是老板（T-041）
  const 团 = await 名单里的团(c.teamId).catch(() => undefined);
  const r = await 云("POST", "/api/sync/leave", { teamId: c.teamId });
  // 老板还有同事在队里：云端不让走（见 sync-relay 退队）。连不上云端、已经被移出（403）照旧在本机退
  if (r.状态 === 409) return { ok: false, error: String(r.json.error ?? "退不了") };
  const 账号 = 读云端凭据()?.accountId;
  const 我id = 账号 ? 团队身份id(账号) : null;
  const 是业务员 = !!我id && 走时只留自己的(c, 团, 账号);
  await 卸触发器(prisma);
  fs.rmSync(配置文件(), { force: true });
  触发器对过 = false;
  // 业务员走了：只留自己的客户（一个人用就是看全部，同事的客户不能跟着他走）。触发器已经卸了，这些删除不推出去
  if (是业务员 && 我id) await 看全部(() => 只留自己的(prisma, 我id));
  // 一个人用了：本机我回到管理员（看全部）。触发器已经卸了，这一改不进日志
  if (我id) await prisma.$executeRawUnsafe(`UPDATE "User" SET role = 'ADMIN' WHERE id = ?`, 我id);
  忘掉限定();
  return { ok: true };
}

let 在跑: Promise<结果<{ 推: number; 拉: number; 撞: number }>> | null = null;
let 欠一轮 = false;

/**
 * 「改完 1.5 秒就推」到点时调这个（lib/team-scope.ts 的 改完推一下，2026-10-04 多台实测抓到）。
 * 没在跑：开一轮。正在跑：那一轮的推送多半已经过去了，复用它等于把这次的改动吞了——记「欠一轮」，它一结束就补
 */
export function 推一下(): Promise<结果<{ 推: number; 拉: number; 撞: number }>> {
  if (在跑) {
    欠一轮 = true;
    return 在跑;
  }
  return 同步一轮();
}
let 触发器对过 = false;

/**
 * 同步一轮：先推后拉（推的时候本机字段钟编好，拉回来的更早的改动就盖不掉本机刚改的）。
 * 同一时间只跑一轮：壳 30 秒一戳、人点「立即同步」，撞上了就等前一轮的结果。
 */
export function 同步一轮(): Promise<结果<{ 推: number; 拉: number; 撞: number }>> {
  // 正在退出团队：不开新的一轮（见 退出团队，2026-10-04 T-009）
  if (退出中 && !在跑) return Promise.resolve({ ok: false, error: "正在退出团队" });
  if (!在跑) {
    // 在同步里：这一轮里回放写库不触发「改完推一下」（lib/team-scope.ts）；用户这时候写的照样排推送
    在跑 = 看全部(() => 在同步里(跑一轮并重试)).finally(() => {
      在跑 = null;
      // 这一轮跑着的时候用户又改了东西（推一下 记的）：这一轮的推送早过去了，马上补一轮
      if (欠一轮 && !退出中) {
        欠一轮 = false;
        void 同步一轮();
      }
    });
    // 云端说我不在这个团队里了：这一轮结束之后（退出团队要等这一轮跑完）看看是不是被移出
    void 在跑.then((r) => { if (!r.ok && /不在这个团队/.test(r.error)) void 被移出后收拾(); });
  }
  return 在跑;
}

/**
 * 碰上 SQLite 的「database schema has changed」（错误码 17）就当场再跑一次（2026-10-04 多台实测见过一次，
 * 在建团队后的第一轮：每个进程第一轮要重装触发器，正好撞上别的连接在写）。它是「表结构刚变过、预编译语句作废了」，
 * 重来一遍就好；原来要等壳下一次戳（8 秒）才自己好，界面上还挂着一条看不懂的英文报错
 */
async function 跑一轮并重试(): Promise<结果<{ 推: number; 拉: number; 撞: number }>> {
  const r = await 跑一轮();
  return !r.ok && /schema has changed/i.test(r.error) ? 跑一轮() : r;
}

async function 跑一轮(): Promise<结果<{ 推: number; 拉: number; 撞: number }>> {
  const 起 = 读团队();
  if (!起) return { ok: false, error: "没有加入团队" };
  let c: 团队配置 = 起;
  const teamId = 起.teamId;
  // 写之前重读：这一轮跑着的时候人退出了（文件没了）或换了团队，就别把旧配置写回去
  const 记 = (x: Partial<团队配置>) => {
    const 现 = 读团队();
    if (现?.teamId === teamId) 写团队({ ...现, ...x });
  };
  try {
    // 每个进程第一轮重装一次触发器：迁移加了列之后老触发器里的列名不全（探针结论）
    if (!触发器对过) {
      await 建同步表(prisma);
      await 装触发器(prisma);
      触发器对过 = true;
    }
    let 推 = 0;
    for (;;) {
      const { 改动, 到 } = await 待推(prisma, c.device);
      if (!改动.length) break;
      const 封这批 = () => 封(改动, c.key, c.epoch ?? 0, { teamId: c.teamId, device: c.device });
      let r = await 云("POST", "/api/sync/push", { teamId: c.teamId, device: c.device, data: 封这批() });
      // 团队换过钥匙（移除了人）：取到新钥匙用新的再推一次
      if (r.状态 === 409 && /换过钥匙/.test(String(r.json.error ?? ""))) {
        c = await 更新钥匙(c);
        r = await 云("POST", "/api/sync/push", { teamId: c.teamId, device: c.device, data: 封这批() });
      }
      if (r.状态 !== 200) {
        const 话 = String(r.json.error ?? `推送失败（${r.状态}）`);
        记({ lastError: 话, lastSyncAt: new Date().toISOString() });
        return { ok: false, error: 话 };
      }
      await 记已推(prisma, 到);
      推 += 改动.length;
    }
    /*
      升级之后本机多了表或列（2026-10-05 复查）：旧版本时收不下、跳过了的那些改动，游标已经走过去了——从头再拉一遍补上。
      没记过签名的（这一版之前入的团队）也重拉一次：那时候可能已经跳过了东西
    */
    const 签名 = await 本机结构签名(prisma);
    /*
      开始重拉时先把签名和 pulled=0 一起记下（二审）：进度只靠 pulled 记，中途退出、断网、坏包都从断点接着拉，
      不会每一轮都从 0 重来；重拉时跳过以前已经认定是坏包的那几批（skipped），不再各试三遍
    */
    const 重拉 = c.结构 !== 签名;
    if (重拉) 记({ pulled: 0, 结构: 签名 });
    const 坏包 = new Set(c.skipped ?? []); // 平常游标早就越过它们了，只有重拉会再碰到
    let 拉 = 0, 撞 = 0, 拉到 = 重拉 ? 0 : c.pulled;
    const 成员行数 = async () => Number((await prisma.$queryRawUnsafe<{ n: number | bigint }[]>(`SELECT count(*) AS n FROM "User" WHERE id LIKE 'acct_%'`))[0]?.n ?? 0);
    const 拉前成员 = await 成员行数();
    for (;;) {
      const r = await 云("GET", `/api/sync/pull?teamId=${encodeURIComponent(c.teamId)}&after=${拉到}`);
      if (r.状态 !== 200) {
        const 话 = String(r.json.error ?? `拉取失败（${r.状态}）`);
        记({ pulled: 拉到, lastError: 话, lastSyncAt: new Date().toISOString() });
        return { ok: false, error: 话 };
      }
      const 批们 = (r.json.batches as { seq: number; device: string; data: string }[]) ?? [];
      // 云端的钥匙比本机新：先取新钥匙，这几批里可能有用新钥匙封的
      if (Number(r.json.epoch ?? 0) > (c.epoch ?? 0)) c = await 更新钥匙(c);
      for (const b of 批们) {
        if (b.device !== c.device && !坏包.has(b.seq)) {
          let 这批: 改动[];
          try {
            这批 = 拆(b.data, 全部钥匙(c), { teamId: c.teamId, device: b.device });
          } catch (e) {
            /*
              解不开：可能是钥匙还没到（下一轮再试），也可能是一批坏包（被移出的人用旧钥匙推的、中转出了错）。
              同一批连着 3 次解不开就跳过、记下，不让它卡死这台电脑后面所有的同步（复查低 4）
            */
            // 缺钥匙（这台还没拿到那一把）不算坏包：等拿到钥匙再解，不能跳
            if (e instanceof Error && /^没有 \d+ 号钥匙/.test(e.message)) throw e;
            const 次 = (读团队()?.bad?.[String(b.seq)] ?? 0) + 1;
            if (次 < 3) {
              const 现 = 读团队();
              记({ bad: { ...(现?.bad ?? {}), [String(b.seq)]: 次 } });
              throw e;
            }
            const 现 = 读团队();
            const { [String(b.seq)]: _丢, ...剩 } = 现?.bad ?? {};
            void _丢;
            记({ bad: 剩, skipped: [...(现?.skipped ?? []), b.seq].slice(-50) });
            拉到 = b.seq;
            记({ pulled: 拉到 });
            continue;
          }
          const 结果 = await 回放(prisma, 这批, c.device);
          拉 += 结果.应用;
          撞 += 结果.撞;
        }
        拉到 = b.seq;
        记({ pulled: 拉到 }); // 每批记一次：中途断了下一轮从这里接着拉，不重复回放
      }
      if (!r.json.more) break;
    }
    记({ pulled: 拉到, 结构: 签名, lastError: null, lastSyncAt: new Date().toISOString(), last: { 推, 拉, 撞 } });
    /*
      收到了别人的改动：设置缓存作废。业务配置（模版、币种、阶段叫法）是全团队一份、会同步过来，
      进程里还缓存着旧的那份的话，业务员加入之后界面一直是自己原来的叫法，要重启才对（2026-10-04 五人实测）
    */
    if (拉 > 0) invalidateSettingsCache();
    /*
      老板 / 业务员：每 5 分钟按名单对一次；**这一轮拉进来新同事的账号行就马上对**（2026-10-04 多台实测）——
      User.role 不同步，远端插进来的那一行默认是 SALES，原来要等 5 分钟，业务员那台上老板一直显示成业务员
    */
    const 来了新同事 = 拉 > 0 && (await 成员行数()) !== 拉前成员;
    if (Date.now() - 上次对角色 > 5 * 60_000 || (拉 > 0 && 上次对角色 === 0) || 来了新同事) await 对齐角色().catch(() => undefined);
    return { ok: true, 推, 拉, 撞 };
  } catch (e) {
    const 话 = e instanceof 同步问题 ? e.message : e instanceof Error && /authenticate|版本|钥匙/.test(e.message) ? "解不开别人推来的改动：邀请码里的钥匙不对，请找老板重新要一份" : `同步出错：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
    记({ lastError: 话, lastSyncAt: new Date().toISOString() });
    return { ok: false, error: 话 };
  }
}

/** 设置 → 团队要的：本机的团队、上次同步、出错原因，以及云端那边的成员和开通状态 */
export async function 团队状态() {
  const c = 读团队();
  if (!c) return { 在团队: false as const, 能用: 能用().ok };
  const r = await 云("GET", "/api/sync/team");
  const 团 = ((r.json.teams as { id: string; name: string; active: boolean; 我是建的人: boolean; 成员: { accountId: string; name: string; contact: string; role: string }[] }[]) ?? []).find((t) => t.id === c.teamId);
  if (团) await 看全部(() => 按名单对角色(团.成员, 团.id)).catch(() => undefined);
  return {
    在团队: true as const,
    /**
     * 云端答得上来、但我的团队列表里没有这个团队：被建团队的人移出了（或者在别的电脑上退出了）。
     * 原来界面上写「连不上云端」、还摆着已经作废的邀请码（2026-10-04 实机）
     */
    被移出: r.状态 === 200 && !团,
    teamName: 团?.name ?? c.teamName,
    active: 团?.active ?? null,
    我是建的人: 团?.我是建的人 ?? false,
    /** 这台能不能移除同事、换邀请码（见 能管理团队）：老板在别的电脑上进来的，这两样只给一句说明 */
    能管理: 能管理团队(c),
    我: 读云端凭据()?.accountId ?? null,
    成员: 团?.成员 ?? [],
    邀请码: 邀请码(c),
    lastSyncAt: c.lastSyncAt ?? null,
    lastError: c.lastError ?? (r.状态 === 200 ? null : String(r.json.error ?? "")),
    last: c.last ?? null,
    /** 回放时撞了合不了的唯一约束、两台因此对不上的几条（T-003）：界面上写「有 N 条没同步上」，不静默 */
    没同步上: await 没同步上(prisma).catch(() => ({ 条数: 0, 例子: [] as { 表: string; 原因: string }[] })),
  };
}

/* ---------------- 老板 / 业务员（2026-10-04 两档权限，lib/team-scope.ts） ---------------- */

let 上次对角色 = 0;

/**
 * 按中转的成员名单对本机的角色：建团队的人（owner）是老板 = ADMIN，其余是业务员 = SALES。
 * User.role 不同步（tables.ts 不同步列），每台各自对，结果一样。用裸 SQL：不碰 updatedAt，也就不进同步日志
 */
async function 按名单对角色(成员: { accountId: string; role: string }[], teamId?: string) {
  if (teamId) 记下老板(teamId, 成员.find((m) => m.role === "owner")?.accountId ?? null);
  for (const m of 成员) {
    const 应 = m.role === "owner" ? "ADMIN" : "SALES";
    await prisma.$executeRawUnsafe(`UPDATE "User" SET role = ? WHERE id = ? AND role <> ?`, 应, 团队身份id(m.accountId), 应);
  }
  上次对角色 = Date.now();
  忘掉限定();
}

export async function 对齐角色() {
  const c = 读团队();
  if (!c) return;
  const r = await 云("GET", "/api/sync/team");
  if (r.状态 !== 200) return;
  const 团 = ((r.json.teams as { id: string; 成员: { accountId: string; role: string }[] }[]) ?? []).find((t) => t.id === c.teamId);
  if (团) await 看全部(() => 按名单对角色(团.成员, 团.id));
}

/**
 * 业务员被老板移出：自动退出团队，这台只留他自己的客户（退出团队 → 只留自己的）。
 * 不等他自己去点——人被移出了多半也不会再打开「设置 → 团队」，同事的客户就一直留在他电脑上。
 * 先问一次云端确认真不在团队里（一次 403 不够：令牌刚换、网关抽风都可能），老板那台不自动退。
 * 是不是业务员和 退出团队() 同一个判法：按上次名单记下的老板、建团队的那台永远不算（T-041，原来看本机 User.role）
 */
let 收拾中 = false;
async function 被移出后收拾() {
  if (收拾中) return;
  收拾中 = true;
  try {
    const s = await 团队状态().catch(() => null);
    if (!s || !s.在团队 || !s.被移出) return;
    const c = 读团队();
    if (!c || !走时只留自己的(c, undefined, 读云端凭据()?.accountId)) return;
    await 退出团队().catch(() => undefined);
  } finally {
    // 收拾完放开：以后进了别的团队又被移出，还要再收拾一次（原来置上就再也不放）
    收拾中 = false;
  }
}
