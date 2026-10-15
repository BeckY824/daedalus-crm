/**
 * 新电脑连上团队（2026-10-15 多设备同步，方案：~/Opensource_CRM/02-开发与发版/多设备同步-方案-20261015.md 第 2 节）。
 *
 * 同一个账号在新电脑上登录后，这台还没有 .team.json，原来就是一片空白、只能找老板要邀请码。现在：
 *   1. 问云端「我的账号在哪个团队里」（团队名单本来就按账号给）→ 界面提示「这台电脑还没连上」
 *   2. 点「在我的另一台电脑上允许」：本机生成设备编号和 X25519 钥匙对，经手机授权那一套接口发申请（/api/mobile/link）
 *   3. 本人另一台已经连上的电脑弹出授权框（components/MobileAuthPrompt），对上配对数字点允许：
 *      那台把团队钥匙环（老板那台连签名钥匙）封给这台的公钥交给中转，中转把这台登记成本人的又一台设备
 *   4. 这台取回封好的那份、用私钥解开，写 .team.json，开始同步（和用邀请码加入后一样：本机已有的客户带进团队）
 *
 * 钥匙一直在两台电脑之间封着走，我们的服务器只转交、解不开。半路的私钥存在 .team-link.json（0600），连上就删。
 * 只有本人的电脑能授权本人的新电脑（服务端按账号核、还要过挑战），老板也替不了业务员点——10-15 你定。
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { prisma } from "../prisma";
import { 设备名 } from "../desktop/cloud";
import { 读团队, 写团队, 能用, 准备本机身份, 本机开同步, 对齐角色, 调云, type 团队配置 } from "./client";
import { 设备钥匙对, 拆自 } from "./crypto";
import { 配对数字 } from "./crypto-web";
import { 看全部 } from "../team-scope";
import type { 电脑授权内容 } from "./mobile-desktop";

type 结果<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const 路径 = "/api/mobile/link";
const 话 = (r: { 状态: number; json: Record<string, unknown> }, 默认: string) => String(r.json.error ?? `${默认}（${r.状态}）`);

type 半路 = { device: string; devPub: string; devPriv: string; accountId: string; at: string };
function 半路文件(): string {
  const dir = process.env.CRM_DATA_DIR;
  if (!dir) throw new Error("没有 CRM_DATA_DIR");
  return path.join(dir, ".team-link.json");
}
function 读半路(): 半路 | null {
  try {
    const x = JSON.parse(fs.readFileSync(半路文件(), "utf8")) as 半路;
    return x.device && x.devPriv ? x : null;
  } catch {
    return null;
  }
}
function 写半路(x: 半路) {
  const f = 半路文件();
  const 临 = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(临, JSON.stringify(x), { mode: 0o600 });
  fs.chmodSync(临, 0o600);
  fs.renameSync(临, f);
}
const 删半路 = () => fs.rmSync(半路文件(), { force: true });

/** 给授权框看的名字：「Edwards-MacBook-Pro（Mac）」 */
const 本机名 = () => `${设备名()}（${process.platform === "darwin" ? "Mac" : process.platform === "win32" ? "Windows" : "电脑"}）`;

export type 云上的团 = { id: string; name: string; 我是建的人: boolean };
export type 连接概况 = {
  /** 这个账号在云上是哪个团队的成员（这台还没连上） */
  云上的团: 云上的团 | null;
  /** 正在等另一台电脑点允许：配对数字 */
  等授权: { 配对数字: string } | null;
  /** 这台电脑上已有几位客户（连上后会带进团队） */
  本机客户: number;
};

/** 这台不在团队里时：账号在云上的团队、半路的申请、本机已有客户数（设置页和首页提示用） */
export async function 连接概况(): Promise<连接概况> {
  const 空: 连接概况 = { 云上的团: null, 等授权: null, 本机客户: 0 };
  if (读团队() || !能用().ok) return 空;
  const r = await 调云("GET", "/api/sync/team");
  const 团 = r.状态 === 200 ? ((r.json.teams as 云上的团[]) ?? [])[0] : undefined;
  const 半 = 读半路();
  const 我 = 能用();
  // 换了账号：上一个账号半路的申请不算
  const 等 = 半 && 我.ok && 半.accountId === 我.accountId ? { 配对数字: await 配对数字(半.devPub) } : null;
  const 本机客户 = await 看全部(() => prisma.customer.count()).catch(() => 0);
  return { 云上的团: 团 ? { id: 团.id, name: 团.name, 我是建的人: !!团.我是建的人 } : null, 等授权: 团 ? 等 : null, 本机客户 };
}

/** 发申请：本人另一台电脑会弹出授权框。回配对数字给这台的界面显示 */
export async function 发起连接(): Promise<结果<{ 配对数字: string }>> {
  const 我 = 能用();
  if (!我.ok) return 我;
  if (读团队()) return { ok: false, error: "这台电脑已经在团队里了" };
  // 同一个账号再点一次：沿用半路那对钥匙（另一台电脑上看到的配对数字不变）
  const 旧 = 读半路();
  const 半: 半路 = 旧 && 旧.accountId === 我.accountId
    ? 旧
    : (() => { const 对 = 设备钥匙对(); return { device: `d${randomBytes(6).toString("hex")}`, devPub: 对.公钥, devPriv: 对.私钥, accountId: 我.accountId, at: new Date().toISOString() }; })();
  const r = await 调云("POST", 路径, { action: "request", device: 半.device, pubKey: 半.devPub, label: 本机名() });
  if (r.状态 !== 200) return { ok: false, error: 话(r, "申请没发出去") };
  写半路(半);
  return { ok: true, 配对数字: await 配对数字(半.devPub) };
}

/** 不等了：删掉半路的钥匙（服务端那条申请会自己过期；另一台电脑上点允许也没用了——这台解不开） */
export function 取消连接(): 结果 {
  删半路();
  return { ok: true };
}

/**
 * 问一下另一台电脑点了没。允许了：解开、核对是封给这台的，写 .team.json，本机开同步。
 * 返回 status：pending 还在等 / denied 被拒 / expired 过期 / joined 连上了
 */
export async function 查连接(): Promise<结果<{ status: "none" | "pending" | "denied" | "expired" | "removed" | "joined"; teamName?: string }>> {
  const 我 = 能用();
  if (!我.ok) return 我;
  if (读团队()) return { ok: true, status: "joined" };
  const 半 = 读半路();
  if (!半 || 半.accountId !== 我.accountId) return { ok: true, status: "none" };
  const r = await 调云("POST", 路径, { action: "status" });
  if (r.状态 !== 200) return { ok: false, error: 话(r, "查不到授权结果") };
  const status = String(r.json.status);
  if (status !== "approved") return { ok: true, status: (["pending", "denied", "expired", "removed"].includes(status) ? status : "none") as "pending" };
  let 内容: 电脑授权内容;
  try {
    内容 = JSON.parse(拆自(半.devPriv, String(r.json.sealed ?? ""))) as 电脑授权内容;
  } catch {
    return { ok: false, error: "授权内容解不开：请在另一台电脑上重新允许" };
  }
  if (内容.v !== 1 || 内容.kind !== "desktop" || 内容.device !== 半.device || 内容.teamId !== r.json.teamId || !内容.key || !内容.joinSecret) {
    return { ok: false, error: "授权内容对不上这台电脑，请在另一台电脑上重新允许" };
  }
  return 收下(内容, 半, 我);
}

/** 连接前备份：这台电脑上已经有客户的，连上之前先 VACUUM INTO 一份（和老板迁移前备份一个做法） */
async function 先备份() {
  const n = await 看全部(() => prisma.customer.count()).catch(() => 0);
  if (!n) return;
  const dir = process.env.CRM_DATA_DIR!;
  const f = path.join(dir, "backups", `before-device-link-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  await prisma.$executeRawUnsafe("VACUUM INTO ?", f);
}

async function 收下(内容: 电脑授权内容, 半: 半路, 我: { accountId: string; contact: string; name: string }): Promise<结果<{ status: "joined"; teamName: string }>> {
  const 准备 = await 准备本机身份(我);
  if (!准备.ok) return 准备;
  try {
    await 先备份();
  } catch (e) {
    console.error("[sync] 连接前备份失败", e);
    return { ok: false, error: "连接前没能备份这台电脑上的数据（磁盘满了？），先没连。腾出空间后再点一次" };
  }
  // 团队的模版、币种以团队为准（和用邀请码加入一样，不推这台的业务配置）
  await 本机开同步(true);
  const c: 团队配置 = {
    teamId: 内容.teamId,
    teamName: 内容.teamName,
    joinSecret: 内容.joinSecret,
    key: 内容.key,
    epoch: 内容.epoch ?? 0,
    keys: 内容.keys ?? {},
    device: 半.device,
    devPub: 半.devPub,
    devPriv: 半.devPriv,
    ...(内容.signPub ? { signPub: 内容.signPub } : {}),
    ...(内容.signPriv ? { signPriv: 内容.signPriv } : {}),
    ...(内容.ownerAccountId ? { ownerAccountId: 内容.ownerAccountId } : {}),
    pulled: 0,
    lastError: null,
  };
  写团队(c);
  删半路();
  await 对齐角色().catch(() => undefined);
  return { ok: true, status: "joined", teamName: 内容.teamName };
}
