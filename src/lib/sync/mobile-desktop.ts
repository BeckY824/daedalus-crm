/**
 * 电脑这一头的「授权手机」（2026-10-15，手机端方案 3.2；服务端见 lib/tenant/mobile-link.ts）。
 *
 * 允许一台手机 = 把这台电脑上的团队信息（团队编号、钥匙环、老板签名公钥、本人在团队里的 id）
 * 用手机自己生成的公钥封好交给中转。中转只转交、解不开；手机用私钥解开后作为本人的又一台设备同步。
 * 批准之前先领挑战：用本机 .team.json 里的设备私钥解开服务端封的随机数，证明是团队里的这台电脑（偷到密码也批不了）。
 * 配对数字：手机屏幕上显示一个、这里算一个，用户对上了再点允许（中转把手机公钥换掉的话两边对不上）。
 */
import { 读团队, 调云 } from "./client";
import { 封给, 拆自 } from "./crypto";
import { 配对数字 } from "./crypto-web";
import { 读 as 读云端凭据 } from "../desktop/cloud";
import { 团队身份id } from "../desktop/me";

type 结果<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const 路径 = "/api/mobile/link";
const 话 = (r: { 状态: number; json: Record<string, unknown> }, 默认: string) => String(r.json.error ?? `${默认}（${r.状态}）`);

/** 封给手机的那一份：手机端 lib/mobile/link.ts 的 打开授权 照这个样子读 */
export type 授权内容 = { v: 1; teamId: string; teamName: string; device: string; key: string; epoch: number; keys: Record<string, string>; signPub?: string; userId: string };

export type 待授权手机 = { id: string; label: string; createdAt: string; 配对数字: string };

export async function 待授权手机(): Promise<结果<{ 手机: 待授权手机[] }>> {
  if (!读团队()) return { ok: true, 手机: [] };
  const r = await 调云("POST", 路径, { action: "pending" });
  if (r.状态 !== 200) return { ok: false, error: 话(r, "查不到待授权的手机") };
  const links = (r.json.links as { id: string; label: string; pubKey: string; createdAt: string }[]) ?? [];
  return { ok: true, 手机: await Promise.all(links.map(async (l) => ({ id: l.id, label: l.label, createdAt: String(l.createdAt), 配对数字: await 配对数字(l.pubKey) }))) };
}

export async function 允许手机(id: string): Promise<结果> {
  const c = 读团队();
  if (!c) return { ok: false, error: "这台电脑还没加入团队：手机只给团队版用" };
  if (!c.devPriv) return { ok: false, error: "这台电脑的团队配置太老，先在「设置 → 团队」里退出再用邀请码重新加入" };
  const 我 = 读云端凭据();
  if (!我?.accountId) return { ok: false, error: "还没登录云端账号" };
  const p = await 调云("POST", 路径, { action: "pending" });
  if (p.状态 !== 200) return { ok: false, error: 话(p, "查不到这台手机") };
  const link = ((p.json.links as { id: string; device: string; pubKey: string }[]) ?? []).find((l) => l.id === id);
  if (!link) return { ok: false, error: "这条申请不在了（可能过期了），请在手机上重新登录" };
  const ch = await 调云("POST", 路径, { action: "challenge", id, teamId: c.teamId, device: c.device });
  if (ch.状态 !== 200) return { ok: false, error: 话(ch, "没能确认这台电脑") };
  let nonce: string;
  try { nonce = 拆自(c.devPriv, String(ch.json.challenge ?? "")); } catch { return { ok: false, error: "没能确认这台电脑（挑战解不开），请重试" }; }
  const 内容: 授权内容 = { v: 1, teamId: c.teamId, teamName: c.teamName, device: link.device, key: c.key, epoch: c.epoch ?? 0, keys: c.keys ?? {}, signPub: c.signPub, userId: 团队身份id(我.accountId!) };
  const sealed = 封给(link.pubKey, JSON.stringify(内容));
  const r = await 调云("POST", 路径, { action: "approve", id, teamId: c.teamId, sealed, nonce });
  return r.状态 === 200 ? { ok: true } : { ok: false, error: 话(r, "授权没成功") };
}

export async function 拒绝手机(id: string): Promise<结果> {
  const r = await 调云("POST", 路径, { action: "deny", id });
  return r.状态 === 200 ? { ok: true } : { ok: false, error: 话(r, "没拒成") };
}

export type 已连接手机 = { id: string; label: string; decidedAt: string | null; lastUsedAt: string | null };
export async function 已连接手机(): Promise<结果<{ 手机: 已连接手机[] }>> {
  const r = await 调云("POST", 路径, { action: "list" });
  if (r.状态 !== 200) return { ok: false, error: 话(r, "查不到已连接的手机") };
  const 团 = 读团队()?.teamId;
  const phones = ((r.json.phones as (已连接手机 & { teamId: string | null })[]) ?? []).filter((x) => !团 || x.teamId === 团);
  return { ok: true, 手机: phones.map(({ id, label, decidedAt, lastUsedAt }) => ({ id, label, decidedAt: decidedAt ? String(decidedAt) : null, lastUsedAt: lastUsedAt ? String(lastUsedAt) : null })) };
}

export async function 移除手机(id: string): Promise<结果> {
  const r = await 调云("POST", 路径, { action: "remove", id });
  return r.状态 === 200 ? { ok: true } : { ok: false, error: 话(r, "没移除成") };
}
