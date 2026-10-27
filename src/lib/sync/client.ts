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
import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "../prisma";
import { 本地模式, 读 as 读云端凭据, 云端地址 } from "../desktop/cloud";
import { 团队身份id } from "../desktop/me";
import { 对齐我的名字 } from "../desktop/my-name";
import { 改身份, 建同步表, 装触发器, 卸触发器, 记全量, 待推, 记已推, 回放, 装了吗, 只留自己的, 没同步上, 本机结构签名, type 改动 } from "./local";
import { createHmac } from "node:crypto";
import { 范围快照, 记录快照, 清理失权副本, 转为范围冲突, 范围冲突数, 验收范围包, 范围包错误, 范围包未到, 主字段, type 拉到的范围包 } from "./scoped-local";
import { 提取范围, 行键, 范围字段, 还等吗, type 范围索引, type 卡住的范围 } from "./scope-policy";
import { 同步表 } from "./tables";
import { 记设备主人, 有不认识的设备 } from "./trash";
import { 报查重 } from "./dedupe-client";
import { 封范围, 规范串 } from "./crypto";
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
  /** 上一轮结束的时间，成没成都记 */
  lastSyncAt?: string;
  /** 上一次**同步上**的时间（2026-10-23）：界面靠它判断「多久没同步上了」，lastSyncAt 出错也会更新 */
  lastOkAt?: string;
  lastError?: string | null;
  /** 人多时云端让前台至少隔几秒才同步一轮（目录里的 pace，2026-10-21）；没有 / 0 = 壳几秒戳就几秒一轮 */
  pace?: number;
  /** 上一轮做了什么，给界面那一行说话 */
  last?: { 推: number; 拉: number; 撞: number };
  /** v4 按范围同步（见 lib/tenant/sync-scoped.ts）。没有 = 仍走旧的全队包 */
  scoped?: 范围配置;
  /**
   * 团队开了「同事之间互相看得到客户」（2026-10-20，老板在设置 → 团队里开，存在中继）。
   * 每轮同步从目录回包、几分钟一次从团队名单拿到它；业务员这台的 team-scope 据此放开读（lib/team-scope.ts）
   */
  互看?: boolean;
  /**
   * 团队版 1b（2026-10-23）：部门树、每人的部门和业务角色、「角色 × 范围」配置表。几分钟一次从团队名单拿到；
   * 客户列表的部门筛选用它。老服务器不回 = 没有，界面照旧
   */
  编制?: 团队编制;
};
export type 团队编制 = {
  部门: { id: string; name: string; parentId: string | null; sort: number; top: string | null }[];
  /** 没分部门的人算在这个一级部门（建得最早的），和云端隔离一个口径 */
  默认: string | null;
  角色范围: { bizRole: string; scope: string }[];
  成员编制: Record<string, { bizRole: string; deptId: string | null; dottedManagerId: string | null }>;
};
export type 范围配置 = {
  stage: "migrating" | "ready";
  /** 每个范围拉到哪个序号、当时的路由版本；版本变大（转交、改归属）从 0 重拉该范围 */
  cursors: Record<string, { after: number; revision: number }>;
  /** 老板迁移：起点已推多少条、服务端新落库多少条（含迁移期间的新改动） */
  baselineSent?: number;
  stored?: number;
  /** 改过归属、还没补发成功「当前状态起点」的记录（行键）；补发成功才移走 */
  snapshotPending?: string[];
  /** 确定性坏包（元数据不符、父链指向不可见记录）跳过了多少 */
  skipped?: number;
  /** 哪些范围这一轮停在「目录里还没有」的那一包前面、等了几轮（scope-policy 还等吗） */
  held?: 卡住的范围;
  /**
   * 上一轮清理：删了多少失权副本、转成冲突几条、AI 历史里可能还提到失权客户的条数（不删，只提示）；
   * 擦净 = 删完之后整库重建、WAL 截断成功（库文件字节里不留删掉的行），false = 下一轮清理先补擦
   */
  cleaned?: { 删: number; 冲突: number; AI残留: number; 擦净?: boolean };
  /** 上一次从头拉时本机的表结构签名（同 团队配置.结构）。变了或没记过 = 各范围游标归零、从头重拉 */
  结构?: string;
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
export function 写团队(c: 团队配置) {
  // 被放开的那一轮后来回来了：不再写，免得拿它手上的旧配置盖掉新一轮的进度（见 看着别卡住）
  if (被取代了()) return;
  动静 = Date.now();
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
let 原传输: 传输 = HTTP;
/** 同步这一轮最后一次有动静（发出 / 收到云端的话、写 .team.json）的时刻：看着别卡住 拿它判断卡没卡 */
let 动静 = 0;
/**
 * 这一轮的票（质量审 #105 建议 1）：看着别卡住 放开一轮时把它的票作废。挂着的那一轮后来回来了，
 * 不再跟云端说话、不再写 .team.json——不然它和新的一轮同时推、同时拉，旧的 pulled 还会把新的盖回去
 */
const 这一轮票 = new AsyncLocalStorage<{ 废: boolean }>();
const 被取代了 = () => 这一轮票.getStore()?.废 === true;
const 云: 传输 = async (方法, 路径, body) => {
  if (被取代了()) return { 状态: 0, json: { error: "这一轮已经被取代" } };
  动静 = Date.now();
  try {
    return await 原传输(方法, 路径, body);
  } finally {
    动静 = Date.now();
  }
};
/** 测试用：换掉和云端说话的方式 */
export function 设传输(t: 传输 | null) {
  原传输 = t ?? HTTP;
}
/** 别的模块（手机授权，sync/mobile-desktop.ts）和云端说话也走这一条：测试里换掉传输时一起换 */
export const 调云: 传输 = (方法, 路径, body) => 云(方法, 路径, body);

/** 本机手上的全部钥匙（之前的 + 现在这把） */
export const 全部钥匙 = (c: 团队配置): 钥匙环 => ({ ...(c.keys ?? {}), [String(c.epoch ?? 0)]: c.key });

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

export function 能用(): 结果<{ accountId: string; contact: string; name: string }> {
  if (!本地模式()) return { ok: false, error: "团队同步只在桌面端用" };
  const c = 读云端凭据();
  if (!c?.accountId) return { ok: false, error: "先登录云端账号" };
  return { ok: true, accountId: c.accountId, contact: c.contact, name: c.name };
}

/**
 * 本机开同步：身份在请求云端建队/入队前预检，随后建表 → 装触发器 → 本机已有的整份记成新建。
 * 已经装过（重新加入另一个团队）：只换团队，不再改身份、不再记全量——日志里已经有了
 */
export async function 本机开同步(加入别人的: boolean) {
  if (await 装了吗(prisma)) return;
  await 建同步表(prisma);
  await 装触发器(prisma);
  // 加入别人团队的不推业务配置：团队的模版、币种以建团队的人为准（见 记全量）；别的成员的账号行也不推（团队里本来就有）
  const 账号 = 读云端凭据()?.accountId;
  await 记全量(prisma, { 不含设置: 加入别人的, ...(加入别人的 && 账号 ? { 本人: 团队身份id(账号) } : {}) });
}

/**
 * 本地身份错误须在云端写成员之前拦住，避免重试在云端留下多支未完成的队。
 * 占位归我：业务员进团队时张三、李四名下的归到本人（见 local.ts 改身份）；老板不传
 */
export async function 准备本机身份(我: { accountId: string; contact: string; name: string }, 选项: { 占位归我?: boolean } = {}): Promise<结果> {
  try {
    if (!await 装了吗(prisma)) {
      // 先和云端对一次名字（2026-10-15）：本机改过没推上去的推上去；新电脑（本机还是「管理员」）拿到云端现在的名字，
      // 不用登录那一刻的旧名字。连不上不拦：改身份 本来就不盖本机改过的名字
      await 对齐我的名字(调云).catch(() => undefined);
      const 云端名 = 读云端凭据()?.name || 我.name;
      await 改身份(prisma, 团队身份id(我.accountId), { email: 我.contact, name: 云端名 || 我.contact.split("@")[0] }, 选项);
    }
    return { ok: true };
  } catch (error) {
    console.error("[sync] 本机身份准备失败", error);
    return { ok: false, error: "本机账号准备失败，尚未创建或加入团队。请先备份数据并联系我们" };
  }
}

export function 建团队(名字: string): Promise<结果<{ 邀请码: string }>> {
  return 看全部(() => 建团队里(名字));
}
async function 建团队里(名字: string): Promise<结果<{ 邀请码: string }>> {
  const 我 = 能用();
  if (!我.ok) return 我;
  if (读团队()) return { ok: false, error: "这台电脑已经在一个团队里了，先退出" };
  if (!名字.trim()) return { ok: false, error: "请填写团队名字" };
  const 准备 = await 准备本机身份(我);
  if (!准备.ok) return 准备;
  const 设备 = `d${randomBytes(6).toString("hex")}`;
  const 对 = 设备钥匙对();
  const 签 = 签名钥匙对();
  const r = await 云("POST", "/api/sync/team", { name: 名字, device: 设备, pubKey: 对.公钥 });
  if (r.状态 !== 200 || !r.json.teamId) return { ok: false, error: String(r.json.error ?? "建不了团队") };
  await 本机开同步(false);
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
  const 准备 = await 准备本机身份(我, { 占位归我: !(await 我是老板吗(解.teamId, 我.accountId)) });
  if (!准备.ok) return 准备;
  const 设备 = `d${randomBytes(6).toString("hex")}`;
  const 对 = 设备钥匙对();
  const r = await 云("POST", "/api/sync/join", { teamId: 解.teamId, joinSecret: 解.joinSecret, device: 设备, pubKey: 对.公钥 });
  if (r.状态 !== 200) return { ok: false, error: String(r.json.error ?? "加入不了") };
  const k = await 收下码里的钥匙(解.teamId, 设备, 解.key, 解.signPub);
  if (!k.ok) return k;
  await 本机开同步(true);
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

/**
 * 记下团队里每台设备是谁的（老板那台，回收站「谁删的」用；sync/trash.ts）。云端只列在册成员的设备，人移出团队后就查不到了，
 * 所以同步完回收站里有对不上人的设备时问一次、移除成员之前问一次
 */
async function 补设备主人(c: 团队配置, 只在要时 = true) {
  if (!能管理团队(c) || (只在要时 && !(await 有不认识的设备(prisma)))) return;
  const d = await 云("GET", `/api/sync/devices?teamId=${encodeURIComponent(c.teamId)}`);
  if (d.状态 === 200) await 记设备主人(prisma, (d.json.devices as { device: string; accountId: string }[]) ?? []);
}

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
  // 移出之前记下他的设备（云端之后就不列了）：回收站里才认得出是他删的
  await 补设备主人(c, false).catch(() => undefined);
  const r = await 云("POST", "/api/sync/remove", { teamId: c.teamId, accountId });
  if (r.状态 !== 200) return { ok: false, error: String(r.json.error ?? "移除不了") };
  写团队({ ...(读团队() ?? c), joinSecret: String(r.json.joinSecret) });
  const k = await 换钥匙并换码(读团队() ?? c, String(r.json.joinSecret));
  return k.ok ? k : { ok: false, error: `人已经移出了，但钥匙没换成：${k.error}。再点一次「换邀请码」` };
}

/**
 * 补换钥匙（2026-10-15 多设备同步）：谁在「我的设备」里移除了一台电脑 / 手机，云端记一笔「该换钥匙了」，
 * 老板那台（手上有签名钥匙的）同步完一轮后看到就换一把——被移除的那台里留着的旧钥匙从此解不开新改动。
 * **口令一起换**（和「换邀请码」同一件事）：被移除的电脑里留着入队口令，口令不换的话，拿到那台电脑的人另注册一个账号
 * 就能凭口令进团队、登记设备，下一次换钥匙还会封给它。几分钟问一次名单，不每轮问
 */
let 上次问换钥匙 = 0;
export async function 老板补换钥匙(强制 = false): Promise<结果<{ 换了: boolean }>> {
  const c = 读团队();
  if (!c || !c.signPriv || !能管理团队(c)) return { ok: true, 换了: false };
  if (!强制 && Date.now() - 上次问换钥匙 < 5 * 60_000) return { ok: true, 换了: false };
  上次问换钥匙 = Date.now();
  const r = await 云("GET", "/api/sync/team");
  if (r.状态 !== 200) return { ok: true, 换了: false };
  const 团 = ((r.json.teams as { id: string; 要换钥匙?: boolean }[]) ?? []).find((t) => t.id === c.teamId);
  if (!团?.要换钥匙) return { ok: true, 换了: false };
  const k = await 一个一个来(换邀请码里);
  return k.ok ? { ok: true, 换了: true } : k;
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

/**
 * 进团队前：这个团的老板是不是我（2026-10-16）。定改身份时张三、李四名下的归不归本人。
 * 知道老板是谁（授权内容里带了）就不问；问不到当业务员——归到本人什么都不丢，反过来业务员那台会丢
 */
export async function 我是老板吗(teamId: string, 我账号: string, 已知老板?: string): Promise<boolean> {
  if (已知老板) return 已知老板 === 我账号;
  const 团 = await 名单里的团(teamId).catch(() => undefined);
  return !!团 && 名单里的老板(团, 我账号) === 我账号;
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
  // 后台在传的产品图片：传完手上这一块就停（D-24）
  await import("./attach-client").then((m) => m.停附件通道(), () => undefined);
  const c = 读团队();
  if (!c) return { ok: true };
  // 先问名单、再退队：退了之后名单里就没有这个团了，问不出谁是老板（T-041）
  const 团 = await 名单里的团(c.teamId).catch(() => undefined);
  // 带上设备号：这台已经在「我的设备」里被移除过的，服务端只当清本机设置、不让整个账号离队（2026-10-15 多设备同步）
  const r = await 云("POST", "/api/sync/leave", { teamId: c.teamId, device: c.device });
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
/** 最近一次叫后台传产品图片（D-24）：动态 import 要一会儿，等图片() 先等它叫上，再等后台那一轮传完 */
let 图片触发: Promise<void> = Promise.resolve();
export function 等图片(): Promise<void> {
  return 图片触发.then(() => import("./attach-client")).then((m) => m.等附件通道());
}
let 欠一轮 = false;
/**
 * 这个进程跑完过一轮没有（质量审 #105 建议 3）：电脑关了一晚上再打开，.team.json 里的 lastOkAt 是昨天的，
 * 第一轮还没跑完就挂「已经十几个小时没同步上」不对。跑完一轮（成没成都算）以后才按 lastOkAt 提醒
 */
let 跑过一轮 = false;

const 默认卡住限时 = 3 * 60_000;
let 卡住限时 = 默认卡住限时;
/** 测试用：多久没动静算卡住（null = 回到默认 3 分钟） */
export function 设卡住限时(ms: number | null) {
  卡住限时 = ms ?? 默认卡住限时;
}

/** 这个进程跑完过一轮没有：设置页「多久没同步上了」的提醒等它（见 跑过一轮） */
export const 这个进程同步过 = () => 跑过一轮;

/** 这一轮同步上了：两个时间一起记 */
function 同步上了() {
  const t = new Date().toISOString();
  return { lastSyncAt: t, lastOkAt: t };
}

/**
 * 一轮卡住了就放开（2026-10-23 团队版用户报「上次同步」停在一个时刻一个多小时）：原来 在跑 没有总限时，
 * 一轮挂在哪一步上不回来，之后每一轮（壳的定时、改完推一下、点「立即同步」）都在等它，同步就停了、界面还看不出来。
 * 和云端说话本身有 30 秒超时，拉得多会一批一批往前走、每批都写 .team.json——所以按「多久没动静」判，不按总时长：
 * 3 分钟里既没跟云端说过话、也没写过进度，就算这一轮卡住，记一条错、放开，下一轮重新来。
 * 放开前已经写下的进度照样有效（每批都记了 pulled）；放开时票作废，挂着的那一轮后来回来也不再跟云端说话、不再写 .team.json
 */
function 看着别卡住<T>(这一轮: Promise<结果<T>>, 票: { 废: boolean }): Promise<结果<T>> {
  动静 = Date.now();
  return new Promise((成, 败) => {
    let 完 = false;
    let 闹: ReturnType<typeof setTimeout> | undefined;
    const 查 = () => {
      if (完) return;
      const 静了 = Date.now() - 动静;
      if (静了 < 卡住限时) {
        闹 = setTimeout(查, Math.max(20, Math.min(卡住限时 - 静了, 15_000)));
        闹.unref?.();
        return;
      }
      完 = true;
      票.废 = true;
      const 话 = `同步卡住了：${Math.max(1, Math.round(卡住限时 / 60_000))} 分钟没有动静，已经重新开始`;
      const c = 读团队();
      // 跳出票的范围再写：同步一轮 可能是从别的一轮里叫起来的，别让外面那张票管到这一笔
      if (c) 这一轮票.exit(() => 写团队({ ...c, lastError: 话, lastSyncAt: new Date().toISOString() }));
      成({ ok: false, error: 话 });
    };
    查();
    这一轮.then(
      (r) => { if (!完) { 完 = true; clearTimeout(闹); 成(r); } },
      (e) => { if (!完) { 完 = true; clearTimeout(闹); 败(e); } },
    );
  });
}

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
 * 壳定时来戳时这一轮要不要跳过（2026-10-21 人多放慢，云端定的间隔见 tenant/sync-scoped.ts 前台最短间隔）。
 * 只管壳的定时戳（/api/desktop/sync）：改完就推（推一下）、「立即同步」直接调 同步一轮，不经过这里。
 * 留 2 秒余量：壳 8 秒一戳，15 秒的实际约 16 秒一轮、30 秒的约 32 秒。上一轮出错了不放慢，照旧下一戳就重试
 */
export function 该放慢(c: 团队配置 | null, now = Date.now()): boolean {
  if (!c?.pace || !c.lastSyncAt || c.lastError) return false;
  return now - Date.parse(c.lastSyncAt) < c.pace * 1000 - 2_000;
}

/**
 * 同步一轮：先推后拉（推的时候本机字段钟编好，拉回来的更早的改动就盖不掉本机刚改的）。
 * 同一时间只跑一轮：壳 30 秒一戳、人点「立即同步」，撞上了就等前一轮的结果。
 */
export function 同步一轮(): Promise<结果<{ 推: number; 拉: number; 撞: number }>> {
  // 正在退出团队：不开新的一轮（见 退出团队，2026-10-04 T-009）
  if (退出中 && !在跑) return Promise.resolve({ ok: false, error: "正在退出团队" });
  if (!在跑) {
    // 在同步里：这一轮里回放写库不触发「改完推一下」（lib/team-scope.ts）；用户这时候写的照样排推送
    const 票 = { 废: false };
    在跑 = 看着别卡住(这一轮票.run(票, () => 看全部(() => 在同步里(跑一轮并重试))), 票).finally(() => {
      在跑 = null;
      跑过一轮 = true;
      // 这一轮跑着的时候用户又改了东西（推一下 记的）：这一轮的推送早过去了，马上补一轮
      if (欠一轮 && !退出中) {
        欠一轮 = false;
        void 同步一轮();
      }
    });
    // 云端说我不在这个团队里了：这一轮结束之后（退出团队要等这一轮跑完）看看是不是被移出
    void 在跑.then((r) => { if (!r.ok && /不在这个团队/.test(r.error)) void 被移出后收拾(); });
    // 老板那台：有人在「我的设备」里移除过设备，补换一把钥匙（几分钟问一次，不每轮问）
    void 在跑.then((r) => { if (r.ok) void 老板补换钥匙().catch(() => undefined); });
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

async function 跑一轮(选项: { 旧协议?: boolean; 只拉?: boolean } = {}): Promise<结果<{ 推: number; 拉: number; 撞: number }>> {
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
    if (!选项.旧协议) {
      const 走 = await 选协议(c);
      if (走 !== "legacy") return 走;
    }
    let 推 = 0;
    for (; !选项.只拉;) {
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
          const 结果 = await 回放(prisma, 这批, c.device, { 留底: 能管理团队(c) });
          拉 += 结果.应用;
          撞 += 结果.撞;
        }
        拉到 = b.seq;
        记({ pulled: 拉到 }); // 每批记一次：中途断了下一轮从这里接着拉，不重复回放
      }
      // 云端说「还有」却一批也没给：游标不会前进，再要也是同一页——停下，下一轮接着拉（不空转、不把这一轮卡死）
      if (!r.json.more || !批们.length) break;
    }
    记({ pulled: 拉到, 结构: 签名, lastError: null, ...同步上了(), last: { 推, 拉, 撞 } });
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
    if (拉 > 0) await 补设备主人(c).catch(() => undefined);
    return { ok: true, 推, 拉, 撞 };
  } catch (e) {
    const 话 = e instanceof 同步问题 ? e.message : e instanceof Error && /authenticate|版本|钥匙/.test(e.message) ? "解不开别人推来的改动：邀请码里的钥匙不对，请找老板重新要一份" : `同步出错：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
    记({ lastError: 话, lastSyncAt: new Date().toISOString() });
    return { ok: false, error: 话 };
  }
}

/** 记下团队的互看开关；变了就让 team-scope 重新读（老服务器不回这一项 = 不动） */
function 记互看(teamId: string, v: unknown) {
  if (typeof v !== "boolean") return;
  const 现 = 读团队();
  if (!现 || 现.teamId !== teamId || (现.互看 ?? false) === v) return;
  写团队({ ...现, 互看: v });
  忘掉限定();
}

/** 名单带回来的编制记进本机配置（变了才写）。服务器不回这一项（老服务器 / 回退）就清掉本机的，别拿旧编制显示 */
function 记编制(teamId: string, v: unknown) {
  const 新 = v && typeof v === "object" && Array.isArray((v as 团队编制).部门) ? (v as 团队编制) : undefined;
  const 现 = 读团队();
  if (!现 || 现.teamId !== teamId || JSON.stringify(现.编制 ?? null) === JSON.stringify(新 ?? null)) return;
  写团队({ ...现, 编制: 新 });
}

/** 本机我的角色按目录对一下：主管 = MANAGER，否则 SALES。老板那台不走这里（目录 owner） */
async function 记主管(是: boolean) {
  const 账号 = 读云端凭据()?.accountId;
  if (!账号) return;
  const 应 = 是 ? "MANAGER" : "SALES";
  const n = await prisma.$executeRawUnsafe(`UPDATE "User" SET role = ? WHERE id = ? AND role <> ? AND role <> 'ADMIN'`, 应, 团队身份id(账号), 应);
  if (n) 忘掉限定();
}

/** 老板把一位同事设成业务主管 / 改回业务员（中继核是不是老板）。本机名单马上对一次，那位同事下一轮同步生效 */
export async function 设角色(谁: string, role: "manager" | "member"): Promise<结果<{ role: string }>> {
  const c = 读团队();
  if (!c) return { ok: false, error: "没有加入团队" };
  const r = await 云("POST", "/api/sync/role", { teamId: c.teamId, accountId: 谁, role });
  if (r.状态 !== 200) return { ok: false, error: String(r.json.error ?? "改不了，请稍后再试") };
  await 对齐角色().catch(() => undefined);
  return { ok: true, role: String(r.json.role ?? role) };
}

/** 老板开 / 关「同事之间互相看得到客户」。业务员那几台下一轮同步生效：开了收全队，关了清掉同事的客户 */
export async function 设互看(on: boolean): Promise<结果<{ on: boolean }>> {
  const c = 读团队();
  if (!c) return { ok: false, error: "没有加入团队" };
  const r = await 云("POST", "/api/sync/share", { teamId: c.teamId, on });
  if (r.状态 !== 200) return { ok: false, error: String(r.json.error ?? "改不了，请稍后再试") };
  记互看(c.teamId, r.json.on === true);
  return { ok: true, on: r.json.on === true };
}

/**
 * 部门、成员的部门和业务角色、配置表、项目进组（1b，云端 /api/sync/dept 核权限）。
 * 改完马上对一次名单：本机角色、编制跟着变；同事那几台下一轮同步生效
 */
export async function 部门操作(action: string, body: Record<string, unknown> = {}): Promise<结果<{ data: Record<string, unknown> }>> {
  const c = 读团队();
  if (!c) return { ok: false, error: "没有加入团队" };
  const r = await 云("POST", "/api/sync/dept", { ...body, teamId: c.teamId, action });
  if (r.状态 !== 200) return { ok: false, error: String(r.json.error ?? "改不了，请稍后再试") };
  if (action !== "invites") await 对齐角色().catch(() => undefined);
  return { ok: true, data: r.json };
}

/** 设置 → 团队要的：本机的团队、上次同步、出错原因，以及云端那边的成员和开通状态 */
export async function 团队状态() {
  const c = 读团队();
  if (!c) return { 在团队: false as const, 能用: 能用().ok };
  const r = await 云("GET", "/api/sync/team");
  const 团 = ((r.json.teams as { id: string; name: string; active: boolean; 我是建的人: boolean; paidUntil?: string; 剩几天?: number; seats?: number; expired?: boolean; 互看?: boolean; 编制?: 团队编制; 成员: { accountId: string; name: string; contact: string; role: string }[] }[]) ?? []).find((t) => t.id === c.teamId);
  if (团) await 看全部(() => 按名单对角色(团.成员, 团.id)).catch(() => undefined);
  if (团) 记互看(团.id, 团.互看);
  if (团) 记编制(团.id, 团.编制);
  return {
    在团队: true as const,
    /**
     * 云端答得上来、但我的团队列表里没有这个团队：被建团队的人移出了（或者在别的电脑上退出了）。
     * 原来界面上写「连不上云端」、还摆着已经作废的邀请码（2026-10-04 实机）
     */
    被移出: r.状态 === 200 && !团,
    teamName: 团?.name ?? c.teamName,
    active: 团?.active ?? null,
    /**
     * 到期日（北京日期）和还剩几天、席位、是不是到期停的（2026-10-15 按时长开通）。
     * 没有到期日 = 不限期；老服务器不回这几项，界面上就不显示
     */
    到期: 团?.paidUntil ? { 日: 团.paidUntil, 剩: Number(团.剩几天 ?? 0) } : null,
    席位: 团?.seats ?? null,
    已到期: 团?.expired === true,
    我是建的人: 团?.我是建的人 ?? false,
    /** 业务主管（2026-10-20）：看全队客户、分配、处理重复；加人、移除、邀请码、开关、业务配置都不归他 */
    我是主管: !(团?.我是建的人) && !!团?.成员.some((m) => m.accountId === 读云端凭据()?.accountId && m.role === "manager"),
    /** 同事之间互相看得到客户。null = 老服务器不认这个开关，界面上不摆 */
    互看: typeof 团?.互看 === "boolean" ? 团.互看 : null,
    /** 部门、业务角色、配置表（1b）。null = 老服务器，界面照旧只有「设主管」 */
    编制: 团?.编制 ?? null,
    /** 这台能不能移除同事、换邀请码（见 能管理团队）：老板在别的电脑上进来的，这两样只给一句说明 */
    能管理: 能管理团队(c),
    我: 读云端凭据()?.accountId ?? null,
    成员: 团?.成员 ?? [],
    /** 手机批准连上的电脑没有入队口令（lib/sync/device-link.ts）：不给一个拼坏的码 */
    邀请码: c.joinSecret ? 邀请码(c) : "",
    lastSyncAt: c.lastSyncAt ?? null,
    lastOkAt: c.lastOkAt ?? null,
    跑过一轮,
    lastError: c.lastError ?? (r.状态 === 200 ? null : String(r.json.error ?? "")),
    last: c.last ?? null,
    /** 回放时撞了合不了的唯一约束、两台因此对不上的几条（T-003）：界面上写「有 N 条没同步上」，不静默 */
    没同步上: await 没同步上(prisma).catch(() => ({ 条数: 0, 例子: [] as { 表: string; 原因: string }[] })),
    /** 范围同步：阶段、待老板核对的失权改动条数（不静默丢弃）、跳过的坏包、上一轮清理结果 */
    范围: await 范围同步概况().catch(() => null),
  };
}

export type 团队价格 = { prices: { months: number; label: string; perSeat: number; perMonth: number }[]; trialDays: number };
/** 团队版价格表（每人，2026-10-15）：存在服务器、运营台改，这里只拿来显示。拿不到（没登录、连不上、老服务器）回 null，界面上就不摆 */
export async function 读价格表(): Promise<团队价格 | null> {
  const r = await 云("GET", "/api/sync/pricing").catch(() => null);
  if (!r || r.状态 !== 200 || !Array.isArray(r.json.prices)) return null;
  const prices = (r.json.prices as 团队价格["prices"]).filter((p) => p && typeof p.perSeat === "number" && typeof p.label === "string");
  return prices.length ? { prices, trialDays: Number(r.json.trialDays) || 0 } : null;
}

/* ---------------- 老板 / 业务员（2026-10-04 两档权限，lib/team-scope.ts） ---------------- */

let 上次对角色 = 0;

/**
 * 按中转的成员名单对本机的角色：建团队的人（owner）是老板 = ADMIN，老板设的业务主管（manager）= MANAGER，其余是业务员 = SALES。
 * User.role 不同步（tables.ts 不同步列），每台各自对，结果一样。用裸 SQL：不碰 updatedAt，也就不进同步日志
 */
async function 按名单对角色(成员: { accountId: string; role: string }[], teamId?: string) {
  if (teamId) 记下老板(teamId, 成员.find((m) => m.role === "owner")?.accountId ?? null);
  for (const m of 成员) {
    const 应 = m.role === "owner" ? "ADMIN" : m.role === "manager" ? "MANAGER" : "SALES";
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
  const 团 = ((r.json.teams as { id: string; 互看?: boolean; 编制?: 团队编制; 成员: { accountId: string; role: string }[] }[]) ?? []).find((t) => t.id === c.teamId);
  if (团) await 看全部(() => 按名单对角色(团.成员, 团.id));
  if (团) 记互看(团.id, 团.互看);
  if (团) 记编制(团.id, 团.编制);
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

/* ---------------- v4 按范围同步：业务员只收本人 + 公海，老板收全队（2026-10-13） ---------------- */

type 轮结果 = 结果<{ 推: number; 拉: number; 撞: number }>;
const 范围路径 = "/api/sync/scoped";
export const 范围请求 = (c: 团队配置, action: string, extra: Record<string, unknown> = {}) => 云("POST", 范围路径, { teamId: c.teamId, action, ...extra });
const 记团队 = (teamId: string, x: Partial<团队配置>) => { const 现 = 读团队(); if (现?.teamId === teamId) 写团队({ ...现, ...x }); };
const 数据目录 = () => { const d = process.env.CRM_DATA_DIR; if (!d) throw new Error("没有 CRM_DATA_DIR"); return d; };
/** 迁移前备份、起点文件：可读的固定名字，不用哈希命名 */
export const 迁移备份文件 = () => path.join(数据目录(), "backups", "before-scoped-sync-migration.db");
const 起点文件 = () => path.join(数据目录(), "scoped-sync-migration-baseline.json");
/** 事件编号：团队钥匙做 HMAC，同一事件重发得到同一编号（服务端去重），中转不能据此反推内容 */
const 事件编号 = (c: 团队配置, 标签: string, e: 改动) => createHmac("sha256", Buffer.from(c.key, "base64url")).update(`${标签}|${规范串(e)}`).digest("hex");
function 做包(c: 团队配置, e: 改动, eventId: string) {
  const meta = 提取范围(e);
  return { meta, eventId, data: 封范围({ meta, change: e }, c.key, c.epoch ?? 0, { teamId: c.teamId, device: c.device, eventId, meta }) };
}
const 错话 = (r: { 状态: number; json: Record<string, unknown> }, 默认: string) => String(r.json.error ?? `${默认}（${r.状态}）`);

/** 服务端 state 回包里决定走哪套协议的几项（见 tenant/sync-scoped.ts 范围状态） */
export type 范围状态回包 = { stage: string; owner: boolean; enabled: boolean; device: string | null };
export type 协议决定 = { 走: "legacy" } | { 走: "scoped" } | { 走: "migrate" } | { 走: "等"; error: string };
export const 等老板迁移 = "团队同步正在升级（业务员电脑只存自己的客户和公海）：需要老板在建团队的那台电脑上打开最新版 Daedalus 同步一次，完成后这台会自动接着同步";

/**
 * 每轮先问服务端：团队在哪个阶段、我是不是老板（以服务端为准，不信本机 User.role）。
 *  - 服务端没有这个接口 / 灰度没开 → 旧协议
 *  - ready → 范围同步
 *  - building：老板在开始迁移的那台继续；别的设备 / 业务员等待
 *  - legacy 且服务端开关开（enabled）：
 *      · 我是老板、在建团队那台 → 老板先迁移。**只看服务端的开关**（2026-10-14 候选 9）：原来还要本机也设 CRM_SCOPED_SYNC=1，
 *        真用户双击打开桌面端，从来不设环境变量——服务端一开，业务员全被 409、老板却永远不迁移，团队卡死。
 *        新建的团队也走这一条：开通后老板那台第一轮就迁移，业务员等它完成
 *      · 老板的其它电脑 → 旧协议（老板的旧接口还能用），等建团队那台迁移
 *      · 业务员 → 等老板（旧接口对业务员一律 409，不去碰；说清楚卡在老板那边）
 *  - 本机 CRM_SCOPED_SYNC=0：显式不开始迁移（应急用，只管「开始」；已经 building / ready 的照旧走新协议，旧流已冻结、退不回去）
 */
export function 定协议(s: 范围状态回包, c: Pick<团队配置, "device"> & { 能管理: boolean }, 本机开关 = process.env.CRM_SCOPED_SYNC): 协议决定 {
  if (s.stage === "ready") return { 走: "scoped" };
  if (s.stage === "building") {
    if (s.owner && s.device === c.device) return { 走: "migrate" };
    return { 走: "等", error: s.owner ? "团队隔离迁移正在老板的另一台电脑上进行，请在那台继续" : "老板正在升级团队同步，完成后这台会自动只同步本人和公海客户" };
  }
  if (!s.enabled || 本机开关?.trim() === "0") return { 走: "legacy" };
  if (!s.owner) return { 走: "等", error: 等老板迁移 };
  return c.能管理 ? { 走: "migrate" } : { 走: "legacy" };
}

async function 选协议(c: 团队配置): Promise<"legacy" | 轮结果> {
  const r = await 范围请求(c, "state");
  // 非 200（旧服务端没有此接口、未开通、已被移出、网络断）一律交给旧流程：它会给出原有的提示，
  // 而迁移后的服务端对旧接口也只会返回 409，不会因此回落成全队包
  if (r.状态 !== 200 || typeof r.json.stage !== "string") return "legacy";
  const owner = !!r.json.owner;
  const d = 定协议({ stage: String(r.json.stage), owner, enabled: !!r.json.enabled, device: r.json.device == null ? null : String(r.json.device) }, { device: c.device, 能管理: 能管理团队(c) });
  if (d.走 === "scoped") return 范围一轮(读团队() ?? c, owner, 读推送规则(r.json));
  if (d.走 === "migrate") return 老板迁移(c, 读推送规则(r.json));
  if (d.走 === "等") {
    记团队(c.teamId, { lastError: d.error, lastSyncAt: new Date().toISOString() });
    return { ok: false, error: d.error };
  }
  return "legacy";
}

/**
 * 老板先迁移（可断点续做）：
 *  1. 本机备份（固定名字，已有不覆盖）
 *  2. 旧协议推完本机改动、拉齐 → begin 冻结旧流，得到 fence
 *  3. 再只拉旧流直到 ≥ fence（冻结前同事推的）
 *  4. 生成按字段钟的完整起点，落到本机文件；按序号分块推，进度记在 .team.json，断了从断点接着推
 *  5. 起点之后本机的新改动照常按范围推；commit 时服务端核对条数，才开放业务员
 */
async function 老板迁移(c0: 团队配置, 规则: 推送规则 = 旧推送规则): Promise<轮结果> {
  let c = c0;
  const teamId = c.teamId;
  try {
    if (!c.scoped) {
      const f = 迁移备份文件();
      if (!fs.existsSync(f)) {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        await prisma.$executeRawUnsafe("VACUUM INTO ?", f);
      }
      // begin 已成功但 .team.json 没记上（上次在这一步断了）：旧推送已被冻结，跳过旧推送直接续做
      const 已开始 = String((await 范围请求(c, "state")).json.stage ?? "") === "building";
      const 前 = await 跑一轮({ 旧协议: true, 只拉: 已开始 });
      if (!前.ok) return 前;
      const b = await 范围请求(c, "begin", { device: c.device });
      if (b.状态 !== 200) return { ok: false, error: 错话(b, "开始迁移失败") };
      记团队(teamId, { scoped: { stage: "migrating", cursors: {}, baselineSent: 0, stored: 0 } });
      c = 读团队() ?? c;
    }
    const s = await 范围请求(c, "state");
    const fence = Number(s.json.fence ?? 0);
    if ((c.pulled ?? 0) < fence) {
      const 拉 = await 跑一轮({ 旧协议: true, 只拉: true });
      if (!拉.ok) return 拉;
      c = 读团队() ?? c;
      if ((c.pulled ?? 0) < fence) return { ok: false, error: "还没拉齐冻结前同事的改动，下一轮继续迁移" };
    }
    let 起点: { cutoff: number; events: 改动[] };
    if (fs.existsSync(起点文件())) 起点 = JSON.parse(fs.readFileSync(起点文件(), "utf8"));
    else {
      await 待推(prisma, c.device, 1); // 先给本机未编钟的改动编上字段钟，起点里的列钟才完整
      起点 = await 范围快照(prisma);
      const 临 = `${起点文件()}.${process.pid}.tmp`;
      fs.writeFileSync(临, JSON.stringify(起点), { mode: 0o600 });
      fs.renameSync(临, 起点文件());
    }
    let sent = c.scoped?.baselineSent ?? 0, stored = c.scoped?.stored ?? 0, 换钥 = 0;
    while (sent < 起点.events.length) {
      const 块 = 起点.events.slice(sent, sent + 100);
      const packets = 块.map((e, i) => ({ ...做包(c, e, 事件编号(c, `baseline|${sent + i}`, e)), baseline: true }));
      const r = await 范围请求(c, "push", { device: c.device, packets });
      if (r.状态 === 409 && /换过钥匙/.test(String(r.json.error ?? "")) && 换钥++ < 3) { c = await 更新钥匙(c); continue; } // 有上限，不无限重试
      if (r.状态 !== 200) return { ok: false, error: 错话(r, "推送迁移起点失败") };
      sent += 块.length; stored += Number(r.json.stored ?? 0);
      记团队(teamId, { scoped: { ...(读团队()?.scoped ?? { stage: "migrating", cursors: {} }), baselineSent: sent, stored } });
    }
    // 起点已含 cutoff 之前的全部日志；之后的日志按范围单条推
    await 记已推(prisma, 起点.cutoff);
    const 后 = await 范围推(c, true);
    if (!后.ok) return 后;
    stored += 后.stored;
    记团队(teamId, { scoped: { ...(读团队()?.scoped ?? { stage: "migrating", cursors: {} }), stored } });
    const done = await 范围请求(c, "commit", { device: c.device, count: stored });
    if (done.状态 !== 200) return { ok: false, error: 错话(done, "完成迁移失败") };
    记团队(teamId, { scoped: { stage: "ready", cursors: {}, baselineSent: sent, stored } });
    fs.rmSync(起点文件(), { force: true });
    return 范围一轮(读团队() ?? c, true, 规则);
  } catch (e) {
    const 话 = e instanceof 同步问题 ? e.message : `团队隔离迁移没完成，下一轮从断点继续：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
    记团队(teamId, { lastError: 话, lastSyncAt: new Date().toISOString() });
    return { ok: false, error: 话 };
  }
}

/**
 * 服务端怎么核一次推送（state 回包的 pushRule）：
 *  - "request-start"（2026-10-14 起）：每包按「这次请求开始时的权限」或「前面几包落下之后」核（scope-policy 推送可写），
 *    转交 / 领取、跟在后面的子记录改动和它的起点快照放进同一次请求就都收；被拒时回包带 denied（被拒的下标）。
 *  - 没有（旧服务端）：逐包按前面几包落下之后的状态核，一次最多 100 包，起点只能事后单独补发。
 */
type 推送规则 = { 按请求开始: boolean; 上限: number };
const 旧推送规则: 推送规则 = { 按请求开始: false, 上限: 100 };
function 读推送规则(json: Record<string, unknown>): 推送规则 {
  if (json.pushRule !== "request-start") return 旧推送规则;
  return { 按请求开始: true, 上限: Math.max(100, Math.min(Math.floor(Number(json.maxPackets) || 100), 1000)) };
}
const 失权原因 = "推送时该记录已不在你的同步范围内（转交、领取或权限变化）；未上传改动已保留，请与老板核对";
/** 403 是不是「这几条不归你了」：新服务端带 denied，旧服务端只有这句话（tenant/sync-scoped.ts 收范围推送） */
const 是按归属被拒 = (r: { json: Record<string, unknown> }) => Array.isArray(r.json.denied) || /同步权限范围/.test(String(r.json.error ?? ""));

/**
 * 按范围推本机日志。
 *
 * 新规则（服务端 request-start）：一块改动里有改归属的（转交、领取、进出公海、改父链），把这些记录当前的起点快照
 * （记录快照：本条 + 全部子记录 + 操作日志）直接附在同一次请求里——这台设备在请求开始时还有权写，服务端照收；
 * 接手的人（或领到的人自己）马上就能从这份起点拉。块里有改归属的就多带一些（最多 300 条），
 * 同一个动作里跟在转交后面的改动（交接带走的计划、操作日志）不被切到下一次请求（那时已经没权了）。
 * 起点太大放不下（> 服务端上限）就不附：先只推改动、起点记成待补（补发起点；自己补不了时由老板那台补，见 范围一轮）。
 *
 * 被拒（403）：新服务端回 denied = 被拒的那几包。只把它们转成显式冲突（不静默丢弃），其余原样重推（整批是回滚了的）；
 * 只有起点包被拒就去掉起点重推。旧服务端没有 denied：照旧逐条重推，仍被拒的转冲突。
 */
async function 范围推(c0: 团队配置, 迁移中 = false, 规则: 推送规则 = 旧推送规则): Promise<结果<{ 推: number; 冲突: number; stored: number }>> {
  let c = c0, 推 = 0, 冲突 = 0, stored = 0;
  const 新规 = 规则.按请求开始 && !迁移中;
  let 不带起点 = false, 重来 = 0, 换钥 = 0;
  for (;;) {
    let { 改动, 到 } = await 待推(prisma, c.device, 新规 ? 300 : 100);
    if (!改动.length) break;
    const 已推 = Number((await prisma.$queryRawUnsafe<{ v: bigint }[]>("SELECT v FROM _sync_cursor WHERE k = 'pushed'"))[0]?.v ?? 0);
    const seqs = (await prisma.$queryRawUnsafe<{ seq: bigint }[]>("SELECT seq FROM _sync_log WHERE seq > ? ORDER BY seq LIMIT ?", 已推, 改动.length)).map((r) => Number(r.seq));
    // 前 100 条里没有改归属的：照常 100 条一块
    if (改动.length > 100 && !改归属根(改动.slice(0, 100)).length) { 改动 = 改动.slice(0, 100); 到 = seqs[99]; }
    const 包 = (e: 改动) => 做包(c, e, 事件编号(c, `log|${c.device}`, e));
    let packets;
    try { packets = 改动.map(包); } catch (e) { throw new 同步问题(`本机有一条改动格式不对，没法按范围推送：${(e as Error).message}`); }
    const roots = 改归属根(改动);
    let 起点包: ReturnType<typeof 包>[] = [];
    if (新规 && roots.length && !不带起点) {
      const events = await 记录快照(prisma, roots);
      // 起点事件编号按（设备, 这一块推到哪条）定：回包丢了重推同一块得到同样的编号，服务端当重复事件收下，不再核权限
      const 快照 = events.map((e, j) => ({ ...做包(c, e, 事件编号(c, `snap|${c.device}|${到}|${j}`, e)), baseline: true }));
      if (packets.length + 快照.length <= 规则.上限 && JSON.stringify(packets).length + JSON.stringify(快照).length < 7 * 1024 * 1024) 起点包 = 快照;
    }
    let r = await 范围请求(c, "push", { device: c.device, packets: [...packets, ...起点包] });
    // 换过钥匙：取新钥匙重推；有上限，云端一直回 409 时这一轮报错停下，不无限重试
    if (r.状态 === 409 && /换过钥匙/.test(String(r.json.error ?? "")) && 换钥++ < 3) { c = await 更新钥匙(c); continue; }
    if (r.状态 === 413 && 起点包.length) { 不带起点 = true; continue; }
    if (r.状态 === 403 && 新规 && Array.isArray(r.json.denied) && 重来++ < 50) {
      const denied = (r.json.denied as unknown[]).filter((i): i is number => Number.isInteger(i));
      const 失权 = denied.filter((i) => i >= 0 && i < 改动.length).map((i) => seqs[i]);
      if (失权.length) {
        冲突 += await 转为范围冲突(prisma, 失权, 失权原因);
        continue;
      }
      if (起点包.length) { 不带起点 = true; continue; }
    }
    // 只有「按归属被拒」才逐条重推、转冲突。设备被移除、人被移出、账号停用也是 403，那是这台整个不能同步了：
    // 原样报出来，改动留在队列里（退出团队后重新连接会整份带上去），不能当成「待老板核对」（2026-10-16 团队版全面检验）
    if (r.状态 === 403 && !迁移中 && 是按归属被拒(r)) {
      const 失权: number[] = [];
      for (let i = 0; i < 改动.length; i++) {
        r = await 范围请求(c, "push", { device: c.device, packets: [包(改动[i])] });
        if (r.状态 === 403) 失权.push(seqs[i]);
        else if (r.状态 !== 200) return { ok: false, error: 错话(r, "推送失败") };
        else stored += Number(r.json.stored ?? 0);
      }
      记待补起点(c.teamId, 改归属根(改动.filter((_, i) => !失权.includes(seqs[i]))));
      冲突 += await 转为范围冲突(prisma, 失权, 失权原因);
      await 记已推(prisma, 到);
      推 += 改动.length - 失权.length;
      continue;
    }
    if (r.状态 !== 200) return { ok: false, error: 错话(r, "推送失败") };
    stored += Number(r.json.stored ?? 0);
    // 起点已经跟着改归属一起落下了就不用再补；没附上的记成待补
    if (!起点包.length) 记待补起点(c.teamId, roots);
    不带起点 = false;
    await 记已推(prisma, 到);
    推 += 改动.length;
  }
  const s = await 补发起点(c);
  if (!s.ok) return s;
  return { ok: true, 推, 冲突, stored: stored + s.stored };
}

/** 这批改动里改了归属的（路由字段变了、进出公海）：要给它们补「改归属之后的起点」的根 */
function 改归属根(改动: 改动[]): string[] {
  const roots = new Set<string>();
  for (const e of 改动) {
    if (e.t === "CustomerPool") roots.add(行键("Customer", e.k));
    else if (e.o === "U" && (范围字段[e.t] ?? []).some((f) => e.c.includes(f))) roots.add(行键(e.t, e.k));
  }
  return [...roots];
}
/** 记成待补发起点的根：先落盘再补发，断了下一轮接着补 */
function 记待补起点(teamId: string, roots: string[]) {
  if (!roots.length) return;
  const 现 = 读团队();
  if (现?.teamId !== teamId) return;
  const sc = 现.scoped ?? { stage: "ready" as const, cursors: {} };
  写团队({ ...现, scoped: { ...sc, snapshotPending: [...new Set([...(sc.snapshotPending ?? []), ...roots])] } });
}
async function 补发起点(c: 团队配置): Promise<结果<{ stored: number }>> {
  const pending = 读团队()?.scoped?.snapshotPending ?? [];
  if (!pending.length) return { ok: true, stored: 0 };
  const events = await 记录快照(prisma, pending);
  const 批次 = `snap|${Date.now()}`;
  let stored = 0;
  for (let i = 0; i < events.length; i += 100) {
    const packets = events.slice(i, i + 100).map((e, j) => ({ ...做包(c, e, 事件编号(c, `${批次}|${i + j}`, e)), baseline: true }));
    const r = await 范围请求(c, "push", { device: c.device, packets });
    // 403：这台已经没有权限写这条（例如刚转走）；起点由仍有权的设备补，这里不卡住
    if (r.状态 === 403) continue;
    if (r.状态 !== 200) return { ok: false, error: 错话(r, "补发起点失败") };
    stored += Number(r.json.stored ?? 0);
  }
  const 现 = 读团队();
  if (现?.teamId === c.teamId && 现.scoped) 写团队({ ...现, scoped: { ...现.scoped, snapshotPending: (现.scoped.snapshotPending ?? []).filter((k) => !pending.includes(k)) } });
  return { ok: true, stored };
}

type 目录范围 = { id: string; revision: number; head?: number; records: 范围索引[] };
/**
 * 上一次拿到的目录（2026-10-21 目录只发变了的），按「团队 | 设备」记：只在内存里，本地服务重启就没了，下次拿全的。
 * 带着 token 去，云端对得上就只回 sig 变了的范围（delta）和看不到了的范围编号（removed），这里合成一份全的
 */
const 上次目录 = new Map<string, { token: string; scopes: Map<string, 目录范围> }>();
function 合目录(键: string, 上次: { token: string; scopes: Map<string, 目录范围> } | undefined, j: Record<string, unknown>): 目录范围[] {
  const 来的 = (j.scopes as 目录范围[]) ?? [];
  const 合 = j.delta === true && 上次 ? new Map(上次.scopes) : new Map<string, 目录范围>();
  if (j.delta === true && 上次) for (const id of (j.removed as string[]) ?? []) 合.delete(id);
  for (const s of 来的) 合.set(s.id, s);
  if (typeof j.token === "string") 上次目录.set(键, { token: j.token, scopes: 合 }); else 上次目录.delete(键);
  return [...合.values()];
}

/** 一次拉多个范围（2026-10-21）：每个请求最多几个范围（服务端上限 500）；老服务端不认就关掉，进程重启再试 */
const 范围每批 = 200;
let 批量拉取可用 = true;
/** 一轮范围同步：推 → 目录 →（业务员）清理失权副本 → 按范围拉、逐包核对后回放 →（老板）补起点 */
let 上次报查重 = "";
async function 范围一轮(c0: 团队配置, owner: boolean, 规则: 推送规则 = 旧推送规则): Promise<轮结果> {
  let c = c0;
  const teamId = c.teamId;
  try {
    if (!c.scoped || c.scoped.stage !== "ready") { 记团队(teamId, { scoped: { ...(c.scoped ?? { cursors: {} }), stage: "ready" } }); c = 读团队() ?? c; }
    /*
      本机表结构变了（升级多了列 / 表）：各范围游标归零、从头重拉，和旧协议的 c.结构 一样（2026-10-22）。
      老版本收到带新列的包只留认得的列、带新表的包整包跳过，游标照样往前；不重拉，升级以后这些再也补不回来。
      没记过的也当变了：这一版之前的客户端从没记过，升级上来先完整拉一遍
    */
    const 签名 = await 本机结构签名(prisma);
    if (c.scoped?.结构 !== 签名) { 记团队(teamId, { scoped: { ...(c.scoped ?? { stage: "ready" }), cursors: {}, 结构: 签名 } }); c = 读团队() ?? c; }
    const p = await 范围推(c, false, 规则);
    if (!p.ok) { 记团队(teamId, { lastError: p.error, lastSyncAt: new Date().toISOString() }); return p; }
    c = 读团队() ?? c;
    // 带上设备号：服务端据此记「我的设备」里的最近同步，被移除的这台在这里就被挡下（2026-10-15 多设备同步）
    const 上次 = 上次目录.get(`${teamId}|${c.device}`);
    const d = await 范围请求(c, "directory", { device: c.device, ...(上次 ? { base: 上次.token } : {}) });
    if (d.状态 !== 200) { const 话 = 错话(d, "取不到同步目录"); 记团队(teamId, { lastError: 话, lastSyncAt: new Date().toISOString() }); return { ok: false, error: 话 }; }
    if (Number(d.json.epoch ?? 0) > (c.epoch ?? 0)) c = await 更新钥匙(c);
    // 人多放慢以这次目录为准（老服务端不回 = 不放慢）
    if ((Number(d.json.pace) || 0) !== (c.pace ?? 0)) 记团队(teamId, { pace: Number(d.json.pace) || 0 });
    // 互看开关以这次目录为准（和下面清理用的是同一份名单）：关掉了，同事的客户不在目录里，清理时删掉；老服务器不回 = 关
    记互看(teamId, d.json.share === true);
    // 主管也以这次目录为准（2026-10-20）：刚被设成 / 改回，本机角色马上跟上，不等 5 分钟一次的对角色
    if (!owner && typeof d.json.manager === "boolean") await 看全部(() => 记主管(d.json.manager === true)).catch(() => undefined);
    c = 读团队() ?? c;
    // 「团队」范围（成员、设置）先拉：客户的负责人得先在本机，不然回放当孤儿跳过（新服务端目录已经这么排，这里给老服务端兜底）
    const scopes = 合目录(`${teamId}|${c.device}`, 上次, d.json).sort((a, b) => Number(b.id === "team") - Number(a.id === "team"));
    const index = new Map<string, 范围索引>();
    for (const s of scopes) for (const r of s.records) index.set(行键(r.t, r.k), r);
    const allowed = new Set(index.keys());
    // 待推已推完（失权的已转冲突）才清理：否则刚建、还没进目录的本人记录会被当成失权
    let cleaned = c.scoped?.cleaned;
    if (!owner) cleaned = await 看全部(() => 清理失权副本(prisma, allowed));
    const cursors: 范围配置["cursors"] = {};
    let 拉 = 0, 撞 = 0, skipped = c.scoped?.skipped ?? 0;
    const held: 卡住的范围 = {};
    // 一页包：逐包核对，目录里还没有的那包停在它前面（连等几轮还没有才当坏包跳过）
    const 收页 = (s: 目录范围, batches: 拉到的范围包[]) => {
      const 收: 改动[] = [];
      let 停在: number | null = null;
      for (const b of batches) {
        try { 收.push(验收范围包(b, 全部钥匙(c), teamId, index.get(行键(b.meta.t, b.meta.k)), allowed)); }
        catch (e) {
          const 等 = e instanceof 范围包未到 ? 还等吗(c.scoped?.held, s.id, b.seq) : null;
          if (等) { held[s.id] = 等; 停在 = b.seq; break; }
          if (e instanceof 范围包错误) { skipped++; continue; }
          throw e;
        }
      }
      return { 收, 到: 停在 == null ? batches : batches.filter((b) => b.seq < 停在!), 停了: 停在 != null };
    };
    const 记游标 = () => 记团队(teamId, { scoped: { ...(读团队()?.scoped ?? { stage: "ready", cursors: {} }), cursors: { ...cursors } } });
    const 拉失败 = (r: { 状态: number; json: Record<string, unknown> }) => {
      const 话 = 错话(r, "拉取失败");
      记团队(teamId, { scoped: { ...(读团队()?.scoped ?? { stage: "ready", cursors: {} }), cursors: { ...(c.scoped?.cursors ?? {}), ...cursors } }, lastError: 话, lastSyncAt: new Date().toISOString() });
      return { ok: false as const, error: 话 };
    };
    const 待拉: { s: 目录范围; after: number }[] = [];
    for (const s of scopes) {
      const cur = c.scoped?.cursors?.[s.id];
      const after = cur && cur.revision >= s.revision ? cur.after : 0;
      // 游标已经到这个范围最新的批次：没什么可拉的，不发请求（2026-10-21：老板一轮原来每位客户一个请求；老服务端不回 head，照旧拉）
      if (typeof s.head === "number" && cur && after >= s.head) { cursors[s.id] = { after, revision: s.revision }; continue; }
      待拉.push({ s, after });
    }
    /*
      一次拉多个范围（2026-10-21，客户 Even 30 人压测：开互看后业务员一个范围一个请求要拉上千次）：「团队」范围照旧单独先拉
     （负责人得先在本机），其余每 范围每批 个一个请求；服务端额度用完的回 later，排到后面再要；看不到了的（403）跳过，
      下一轮新目录里就没有它了。老服务端不认 pull-many 就退回一个一个拉
    */
    const 单拉 = async (s: 目录范围, 起: number) => {
      let after = 起;
      for (;;) {
        const r = await 范围请求(c, "pull", { scopeId: s.id, after, device: c.device });
        if (r.状态 !== 200) return r;
        const batches = (r.json.batches as 拉到的范围包[]) ?? [];
        const 页 = 收页(s, batches);
        if (页.收.length) { const x = await 回放(prisma, 页.收, c.device, { 留底: 能管理团队(c) }); 拉 += x.应用; 撞 += x.撞; }
        if (页.到.length) after = 页.到[页.到.length - 1].seq;
        cursors[s.id] = { after, revision: s.revision };
        记游标();
        if (页.停了 || !r.json.more || !batches.length) return null; // 同上：没前进就不再要同一页
      }
    };
    // 「团队」范围先单独拉完
    for (const x of 待拉) if (x.s.id === "team") { const r = await 单拉(x.s, x.after); if (r) return 拉失败(r); }
    const 一批批 = 待拉.filter((x) => x.s.id !== "team");
    const 单个: typeof 待拉 = [];
    if (!批量拉取可用) 单个.push(...一批批.splice(0));
    while (一批批.length) {
      const 这批 = 一批批.splice(0, 范围每批);
      const r = await 范围请求(c, "pull-many", { device: c.device, scopes: 这批.map((x) => ({ scopeId: x.s.id, after: x.after })) });
      if (r.状态 === 400 && r.json?.error === "未知同步操作") { 批量拉取可用 = false; 单个.push(...这批, ...一批批.splice(0)); break; }
      if (r.状态 !== 200) return 拉失败(r);
      const 回 = new Map(((r.json.scopes as { scopeId: string; later?: boolean; error?: number; more?: boolean; batches?: 拉到的范围包[] }[]) ?? []).map((x) => [x.scopeId, x]));
      const 收: 改动[] = [];
      const 前进: { s: 目录范围; after: number }[] = [];
      for (const x of 这批) {
        const y = 回.get(x.s.id);
        if (!y || y.error) continue; // 回里没有（不该出现）或看不到了：这一轮跳过，游标不动
        if (y.later) { 一批批.push(x); continue; }
        const batches = y.batches ?? [];
        const 页 = 收页(x.s, batches);
        收.push(...页.收);
        const after = 页.到.length ? 页.到[页.到.length - 1].seq : x.after;
        前进.push({ s: x.s, after });
        if (!页.停了 && y.more && batches.length) 一批批.push({ s: x.s, after });
      }
      // 各范围的包按批次号合起来回放一次（就是它们进中转的先后），游标在回放之后才前进
      if (收.length) { const z = await 回放(prisma, 收, c.device, { 留底: 能管理团队(c) }); 拉 += z.应用; 撞 += z.撞; }
      for (const x of 前进) cursors[x.s.id] = { after: x.after, revision: x.s.revision };
      记游标();
    }
    for (const x of 单个) { const r = await 单拉(x.s, x.after); if (r) return 拉失败(r); }
    // 目录里已经删掉、本机却还留着的记录：照目录补一次删除（候选 6 实机：同一账号另一台领取后，这台公海那一行一直不走）
    const 补删 = await 照目录补删除(index.values(), c.device, 能管理团队(c));
    拉 += 补删;
    记团队(teamId, { scoped: { ...(读团队()?.scoped ?? { stage: "ready" }), stage: "ready", cursors, skipped, held, cleaned }, lastError: null, ...同步上了(), last: { 推: p.推, 拉, 撞 } });
    /*
      老板那台补起点：目录里的 needBaseline = 改过归属、有业务员看得到、却还没有改归属之后起点的记录
      （交出去的人是旧版本客户端、起点太大没跟转交一起推、推完转交就断了……）。老板收全队、刚拉齐，永远有权写，由它补上；
      补不上（本机还没有这条）下一轮目录里还会列出来。
    */
    const need = owner && Array.isArray(d.json.needBaseline) ? (d.json.needBaseline as unknown[]).filter((k): k is string => typeof k === "string") : [];
    if (need.length) {
      记待补起点(teamId, need);
      const s = await 补发起点(读团队() ?? c);
      if (!s.ok) { 记团队(teamId, { lastError: s.error, lastSyncAt: new Date().toISOString() }); return s; }
    }
    if (拉 > 0) invalidateSettingsCache();
    // 跨成员查重的索引（2026-10-19，sync/dedupe-client.ts）：有推有拉、换了钥匙、这次启动还没报过才报一遍；报不上不算这一轮失败
    const 报的是 = `${teamId}|${c.device}|${(读团队() ?? c).epoch ?? 0}`;
    if (p.推 > 0 || 拉 > 0 || 上次报查重 !== 报的是) await 报查重(读团队() ?? c).then(() => { 上次报查重 = 报的是; }, () => undefined);
    if (Date.now() - 上次对角色 > 5 * 60_000 || (拉 > 0 && 上次对角色 === 0)) await 对齐角色().catch(() => undefined);
    // 产品图片的文件（D-24，sync/attach-client.ts）：行推完、拉完再在后台传文件，不占着这一轮（质量审 #93 D）。
    // 传不上不算这一轮失败；空间满了要人处理，由它记一句
    图片触发 = import("./attach-client").then((m) => m.后台传附件(), () => undefined);
    if (拉 > 0) await 补设备主人(c).catch(() => undefined);
    return { ok: true, 推: p.推, 拉, 撞 };
  } catch (e) {
    const 话 = e instanceof 同步问题 ? e.message : `同步出错：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
    记团队(teamId, { lastError: 话, lastSyncAt: new Date().toISOString() });
    return { ok: false, error: 话 };
  }
}

/**
 * 目录里标着已删除、本机还有这一行的记录，补一次删除（2026-10-14 候选 6 实机）。
 * 删除只在本机落：当成回放（不进推送队列），用目录里的字段钟当删除钟——本机这一行有更晚的字段钟（别人删之后又改过）就不删；
 * 本机还有没推上去的改动的记录不动，等推送有了结论再说（这里先筛一遍；读完待推之后人又写的那一笔，由 回放 在事务里先编字段钟兜住）。
 * 只用目录里的编号和钟，不碰任何密文。
 * 旧服务端 / 已经把游标拉过了删除包的设备（游标在删除包之后）靠这一步收尾；新服务端拉取时也会直接给删除包。
 */
async function 照目录补删除(rows: Iterable<范围索引>, 设备: string, 留底 = false): Promise<number> {
  const 删了 = [...rows].filter((r) => r.deleted && r.clock);
  if (!删了.length) return 0;
  const 待推 = new Set((await prisma.$queryRawUnsafe<{ tbl: string; pk: string }[]>("SELECT DISTINCT tbl, pk FROM _sync_log WHERE seq > COALESCE((SELECT v FROM _sync_cursor WHERE k = 'pushed'), 0)")).map((r) => 行键(r.tbl, r.pk)));
  const 按表 = new Map<string, 范围索引[]>();
  for (const r of 删了) if ((同步表 as readonly string[]).includes(r.t) && !待推.has(行键(r.t, r.k))) 按表.set(r.t, [...(按表.get(r.t) ?? []), r]);
  const 要删: 改动[] = [];
  for (const [t, rs] of 按表) {
    const pk = 主字段(t);
    for (let i = 0; i < rs.length; i += 400) {
      const part = rs.slice(i, i + 400);
      const 在 = new Set((await prisma.$queryRawUnsafe<{ k: string }[]>(`SELECT "${pk}" AS k FROM "${t}" WHERE "${pk}" IN (${part.map(() => "?").join(",")})`, ...part.map((r) => r.k))).map((x) => String(x.k)));
      for (const r of part) if (在.has(r.k)) 要删.push({ t, k: r.k, o: "D", r: null, c: [], h: r.clock });
    }
  }
  if (!要删.length) return 0;
  return (await 回放(prisma, 要删, 设备, { 含本人: true, 留底 })).应用;
}

/** 设置 → 团队显示用：范围同步状态与待核对冲突数 */
export async function 范围同步概况() {
  const c = 读团队();
  return { 阶段: c?.scoped?.stage ?? "legacy", 冲突: await 范围冲突数(prisma), 跳过: c?.scoped?.skipped ?? 0, 清理: c?.scoped?.cleaned ?? null };
}
