/**
 * 电脑这一头的「授权手机」（2026-10-15，手机端方案 3.2；服务端见 lib/tenant/mobile-link.ts）。
 *
 * 允许一台手机 = 把这台电脑上的团队信息（团队编号、钥匙环、老板签名公钥、本人在团队里的 id）
 * 用手机自己生成的公钥封好交给中转。中转只转交、解不开；手机用私钥解开后作为本人的又一台设备同步。
 * 批准之前先领挑战：用本机 .team.json 里的设备私钥解开服务端封的随机数，证明是团队里的这台电脑（偷到密码也批不了）。
 * 配对数字：手机屏幕上显示一个、这里算一个，用户对上了再点允许（中转把手机公钥换掉的话两边对不上）。
 *
 * 2026-10-15 多设备同步：本人的**新电脑**也走这一套（服务端同一张申请表，设备编号 d 开头）。封给电脑的多几样：
 * 入队口令（设置页显示邀请码用）、老板是谁；这台是老板那台（手上有签名私钥）时连签名私钥一起封过去——
 * 老板在第二台电脑上也能移除同事、换邀请码。新电脑那头见 lib/sync/device-link.ts。
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
/** 封给本人新电脑的那一份：lib/sync/device-link.ts 的 查连接 照这个样子读 */
export type 电脑授权内容 = 授权内容 & { kind: "desktop"; joinSecret: string; signPriv?: string; ownerAccountId?: string };

const 是电脑 = (device: string) => /^d[0-9a-f]{12}$/.test(device);

export type 待授权手机 = { id: string; label: string; createdAt: string; 配对数字: string; 电脑: boolean };

/**
 * 要不要挂授权框（app 的 layout 用）：这台进了团队才可能有手机 / 本人别的电脑来要授权。
 * 个人版、还没进团队的不挂，前台时就不会每 15 秒白问一次（优化 #11）。建团队、加入、连上都会刷新 layout，进了团队马上就挂上。
 */
export function 要问待授权手机(): boolean {
  return 读团队() !== null;
}

export async function 待授权手机(): Promise<结果<{ 手机: 待授权手机[] }>> {
  if (!读团队()) return { ok: true, 手机: [] };
  const r = await 调云("POST", 路径, { action: "pending" });
  if (r.状态 !== 200) return { ok: false, error: 话(r, "查不到待授权的手机") };
  const links = (r.json.links as { id: string; label: string; device: string; pubKey: string; createdAt: string }[]) ?? [];
  return { ok: true, 手机: await Promise.all(links.map(async (l) => ({ id: l.id, label: l.label, createdAt: String(l.createdAt), 配对数字: await 配对数字(l.pubKey), 电脑: 是电脑(String(l.device)) }))) };
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
  const 给电脑: 电脑授权内容 | null = 是电脑(link.device)
    ? { ...内容, kind: "desktop", joinSecret: c.joinSecret, ownerAccountId: c.ownerAccountId, ...(c.signPriv ? { signPriv: c.signPriv } : {}) }
    : null;
  const sealed = 封给(link.pubKey, JSON.stringify(给电脑 ?? 内容));
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

/* ---------- 我的设备（2026-10-15 多设备同步）：本人在团队里的电脑和手机，丢了的在这里移除。服务端见 lib/tenant/my-devices.ts ---------- */

export type 我的一台 = { device: string; 种类: "电脑" | "手机"; label: string; 连上: string; 最近同步: string | null; 这台: boolean };

export async function 我的设备(): Promise<结果<{ 设备: 我的一台[]; 上限: number }>> {
  const c = 读团队();
  if (!c) return { ok: true, 设备: [], 上限: 3 };
  const r = await 调云("POST", "/api/sync/my-devices", { action: "list", teamId: c.teamId });
  if (r.状态 !== 200) return { ok: false, error: 话(r, "查不到我的设备") };
  const 设备 = ((r.json.devices as 我的一台[]) ?? []).map((d) => ({
    device: d.device, 种类: d.种类, label: d.label, 连上: String(d.连上), 最近同步: d.最近同步 ? String(d.最近同步) : null,
    // 服务端按令牌认「这台」；这台还没在新版本上同步过（没记令牌）时按设备编号认
    这台: !!d.这台 || d.device === c.device,
  }));
  return { ok: true, 设备, 上限: Number(r.json.上限 ?? 3) };
}

export async function 移除设备(device: string): Promise<结果> {
  const c = 读团队();
  if (!c) return { ok: false, error: "没有加入团队" };
  if (device === c.device) return { ok: false, error: "正在用的这台不能在这里移除：要让这台停止同步，请点「退出团队」" };
  const r = await 调云("POST", "/api/sync/my-devices", { action: "remove", teamId: c.teamId, device });
  return r.状态 === 200 ? { ok: true } : { ok: false, error: 话(r, "没移除成") };
}
