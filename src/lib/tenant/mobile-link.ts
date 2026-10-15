/**
 * 手机连团队的中转（2026-10-15，手机端方案 3.2）。
 *
 *   手机：账号密码登录（/api/account/token，拿到长期令牌）→ 自己生成 X25519 钥匙对 → 申请（带公钥）→ 等
 *   电脑（同一个账号）：看到待授权 → 对一眼配对数字 → 允许：把团队钥匙环等封给手机公钥交上来
 *   服务端：核这台电脑的账号确实在这个团队里，把手机登记成这个成员的一台同步设备（之后换钥匙也会给它封一份），存下密文
 *   手机：再问一次，拿到密文，自己用私钥解开，开始同步
 *
 * 我们这边只见得到：哪个账号、哪枚令牌、手机公钥、手机型号这类标签、封好的密文。团队钥匙、客户内容一样都见不到。
 * 只有本人的电脑能授权本人的手机（按账号核），老板也替不了业务员点——传出去的是他电脑上的数据。
 * 移除：作废手机那枚令牌（它从此连不上任何接口）、注销同步设备（之后换钥匙不再给它封）。
 *
 * **批准要证明是团队里那台电脑**（挑战）：只凭账号令牌就能批的话，偷到密码的人开两个会话，一个装手机申请、一个自己批，
 * 就把自己的设备登记进团队，之后老板每次换钥匙都会封一份给它——而今天没有邀请码根本进不来。所以批准前服务端用
 * 这台电脑登记在团队里的公钥（SyncDevice）封一个一次性随机数，电脑用只在本机 .team.json 里的私钥解开、交回来才算数。
 * 手机设备（m_ 开头）不能批别的手机：授权的意思是「把电脑上的数据给手机」。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { control } from "./control";
import { 登记设备, 在队里 } from "./sync-relay";
import { 吊销 } from "./device-token";
import { 封给 } from "../sync/crypto";

type 结果<T> = ({ ok: true } & T) | { ok: false; 状态: number; error: string };
const 错 = (状态: number, error: string) => ({ ok: false as const, 状态, error });

const 设备号对 = (d: unknown): d is string => typeof d === "string" && /^m_[\w-]{8,60}$/.test(d);
/** 一个账号同时挂着的手机申请不多于几条：挡住脚本刷表 */
export const 待授权上限 = 5;
/** 等了这么久没人点，就当作废：手机那边重新申请 */
export const 申请有效毫秒 = 24 * 3600_000;

export type 手机申请 = { id: string; device: string; pubKey: string; label: string; createdAt: Date };

/** 手机发申请。同一枚令牌再发一次：还在等的原样返回（手机重开页面不会多出一条） */
export async function 申请(accountId: string, tokenId: string, x: { device?: unknown; pubKey?: unknown; label?: unknown }): Promise<结果<{ id: string; status: string }>> {
  const label = String(x.label ?? "").trim().slice(0, 60) || "手机";
  if (!设备号对(x.device)) return 错(400, "设备信息不对");
  // 公钥长相和真伪交给 登记设备 在允许时核；这里先挡掉明显不对的，免得电脑上弹出一条点了也会失败的申请
  if (typeof x.pubKey !== "string" || !/^[\w-]{40,200}$/.test(x.pubKey)) return 错(400, "设备信息不对");
  const 已 = await control.syncMobileLink.findUnique({ where: { tokenId } });
  if (已) {
    if (已.accountId !== accountId) return 错(403, "登录已失效，请重新登录");
    if (已.status === "pending" && (已.device !== x.device || 已.pubKey !== x.pubKey)) {
      await control.syncMobileLink.update({ where: { id: 已.id }, data: { device: x.device, pubKey: x.pubKey, label, createdAt: new Date() } });
    }
    return { ok: true, id: 已.id, status: 已.status };
  }
  const 在等 = await control.syncMobileLink.count({ where: { accountId, status: "pending", createdAt: { gt: new Date(Date.now() - 申请有效毫秒) } } });
  if (在等 >= 待授权上限) return 错(429, "等着授权的手机太多了，先在电脑上处理一下");
  const r = await control.syncMobileLink.create({ data: { accountId, tokenId, device: x.device, pubKey: x.pubKey, label, status: "pending" } });
  return { ok: true, id: r.id, status: r.status };
}

/** 手机问：我的申请怎么样了。允许了就带上封好的那份（只有这台手机的私钥解得开） */
export async function 我的申请(accountId: string, tokenId: string): Promise<结果<{ status: string; teamId: string | null; sealed: string | null }>> {
  const r = await control.syncMobileLink.findUnique({ where: { tokenId } });
  if (!r || r.accountId !== accountId) return { ok: true, status: "none", teamId: null, sealed: null };
  const 过期 = r.status === "pending" && Date.now() - r.createdAt.getTime() > 申请有效毫秒;
  return { ok: true, status: 过期 ? "expired" : r.status, teamId: r.teamId, sealed: r.status === "approved" ? r.sealed : null };
}

/** 电脑上：本账号在等授权的手机 */
export async function 待授权(accountId: string): Promise<结果<{ links: 手机申请[] }>> {
  const links = await control.syncMobileLink.findMany({
    where: { accountId, status: "pending", createdAt: { gt: new Date(Date.now() - 申请有效毫秒) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, device: true, pubKey: true, label: true, createdAt: true },
  });
  return { ok: true, links };
}

/** 挑战多久内要交回来 */
export const 挑战有效毫秒 = 5 * 60_000;
const 摘要 = (s: string) => createHash("sha256").update(s).digest("hex");

/** 电脑要批之前先领挑战：用这台电脑登记在团队里的公钥封一个一次性随机数（只有它的私钥解得开） */
export async function 挑战(accountId: string, id: string, teamId: string, device: string): Promise<结果<{ challenge: string }>> {
  const r = await control.syncMobileLink.findUnique({ where: { id: String(id ?? "") } });
  if (!r || r.accountId !== accountId || r.status !== "pending") return 错(404, "这条申请不在了");
  if (typeof device !== "string" || device.startsWith("m_")) return 错(403, "要在电脑上授权");
  const 机 = await control.syncDevice.findUnique({ where: { teamId_device: { teamId: String(teamId ?? ""), device } } });
  if (!机 || 机.accountId !== accountId || !(await 在队里(机.teamId, accountId))) return 错(403, "这台电脑不在这个团队里");
  const nonce = randomBytes(32).toString("base64url");
  await control.syncMobileLink.update({ where: { id: r.id }, data: { proofHash: 摘要(nonce), proofDevice: device, proofAt: new Date() } });
  return { ok: true, challenge: 封给(机.pubKey, nonce) };
}

/** 电脑上点了允许：交回挑战里的随机数，sealed 是电脑封给手机公钥的团队信息。核过之后把手机登记成这个成员的同步设备 */
export async function 允许(accountId: string, id: string, teamId: string, sealed: string, nonce: string): Promise<结果<object>> {
  if (typeof sealed !== "string" || !sealed || sealed.length > 64 * 1024) return 错(400, "授权内容不对");
  return control.$transaction(async (tx) => {
    const r = await tx.syncMobileLink.findUnique({ where: { id: String(id ?? "") } });
    if (!r || r.accountId !== accountId) return 错(404, "这条申请不在了");
    if (r.status !== "pending") return 错(409, r.status === "approved" ? "这台手机已经授权过了" : "这条申请已经处理过了");
    if (Date.now() - r.createdAt.getTime() > 申请有效毫秒) return 错(410, "申请过期了，请在手机上重新登录");
    // 事务里一律用 tx 查：SQLite 只有一个写连接，事务外的查询会和事务互相等到超时
    const 成员 = await tx.syncMember.findUnique({ where: { teamId_accountId: { teamId: String(teamId ?? ""), accountId } } });
    if (!成员 || 成员.leftAt) return 错(403, "你不在这个团队里了");
    const 对 = typeof nonce === "string" && !!r.proofHash && !!r.proofAt && Date.now() - r.proofAt.getTime() < 挑战有效毫秒 &&
      timingSafeEqual(Buffer.from(摘要(nonce)), Buffer.from(r.proofHash));
    // 挑战只能用一次：对不对都清掉
    await tx.syncMobileLink.update({ where: { id: r.id }, data: { proofHash: null, proofAt: null } });
    if (!对) return 错(403, "没能确认是团队里的这台电脑，请重试");
    const 机 = await tx.syncDevice.findUnique({ where: { teamId_device: { teamId, device: r.proofDevice ?? "" } } });
    if (!机 || 机.accountId !== accountId) return 错(403, "这台电脑不在这个团队里");
    const 设备错 = await 登记设备(teamId, accountId, { device: r.device, pubKey: r.pubKey }, tx);
    if (设备错) return 错(409, 设备错);
    await tx.syncMobileLink.update({ where: { id: r.id }, data: { status: "approved", teamId, sealed, decidedAt: new Date() } });
    return { ok: true as const };
  });
}

export async function 拒绝(accountId: string, id: string): Promise<结果<object>> {
  const n = await control.syncMobileLink.updateMany({ where: { id: String(id ?? ""), accountId, status: "pending" }, data: { status: "denied", decidedAt: new Date(), sealed: null } });
  return n.count ? { ok: true } : 错(404, "这条申请不在了");
}

/** 电脑上：已经连着的手机（最后一次用是令牌的 lastUsedAt） */
export async function 已连接(accountId: string): Promise<结果<{ phones: { id: string; label: string; teamId: string | null; createdAt: Date; decidedAt: Date | null; lastUsedAt: Date | null }[] }>> {
  const links = await control.syncMobileLink.findMany({ where: { accountId, status: "approved" }, orderBy: { decidedAt: "desc" } });
  const tokens = await control.deviceToken.findMany({ where: { id: { in: links.map((l) => l.tokenId) } }, select: { id: true, lastUsedAt: true, revokedAt: true } });
  const 令牌 = new Map(tokens.map((t) => [t.id, t]));
  return {
    ok: true,
    phones: links.filter((l) => !令牌.get(l.tokenId)?.revokedAt).map((l) => ({ id: l.id, label: l.label, teamId: l.teamId, createdAt: l.createdAt, decidedAt: l.decidedAt, lastUsedAt: 令牌.get(l.tokenId)?.lastUsedAt ?? null })),
  };
}

/** 移除一台手机：作废它的令牌、注销同步设备、清掉密文。手机下一次同步就是「登录已失效」 */
export async function 移除(accountId: string, id: string): Promise<结果<object>> {
  const r = await control.syncMobileLink.findUnique({ where: { id: String(id ?? "") } });
  if (!r || r.accountId !== accountId) return 错(404, "这台手机不在了");
  await 吊销(r.tokenId, accountId);
  if (r.teamId) await control.syncDevice.deleteMany({ where: { teamId: r.teamId, device: r.device, accountId } });
  await control.syncMobileLink.update({ where: { id: r.id }, data: { status: "removed", sealed: null, decidedAt: new Date() } });
  return { ok: true };
}
