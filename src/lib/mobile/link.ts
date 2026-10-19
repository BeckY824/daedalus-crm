/**
 * 手机这一头的「连团队」（2026-10-15，手机端方案 3.2）。电脑那头见 lib/sync/mobile-desktop.ts，中转见 lib/tenant/mobile-link.ts。
 *   1. 账号密码登录拿到令牌（页面那边做）
 *   2. 生成不可导出的 X25519 钥匙对 + 设备编号，发申请，屏幕上显示配对数字
 *   3. 轮询：电脑点了允许就拿到封好的那份，用私钥解开 → 手机团队，开始同步
 */
import * as 密 from "@/lib/sync/crypto-web";
import type { 传输, 手机团队 } from "./sync";
import { 手机资格话, type 手机资格 } from "@/lib/team-pricing";

const 路径 = "/api/mobile/link";
const 话 = (r: { 状态: number; json: Record<string, unknown> }, 默认: string) => String(r.json.error ?? `${默认}（${r.状态}）`);

export function 新设备号(): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return "m_" + 密.转b64u(b);
}

/**
 * 登录后先问：这个账号能不能连手机（2026-10-19，个人版账号不给连）。旧服务端没有这个操作（400 / 404）就当能连，照原来的流程走
 */
export async function 查资格(云: 传输): Promise<手机资格> {
  const r = await 云("POST", 路径, { action: "eligibility" });
  if (r.状态 === 401) throw new Error(话(r, "登录已失效，请重新登录"));
  const s = String(r.json.status ?? "");
  return r.状态 === 200 && s in 手机资格话 ? (s as 手机资格) : "ok";
}

/** 发申请被服务端按资格拦下时，认出是哪一种（和 查资格 同一屏） */
export function 资格被拦(话: string): Exclude<手机资格, "ok"> | null {
  const k = (Object.keys(手机资格话) as Exclude<手机资格, "ok">[]).find((x) => 手机资格话[x] === 话);
  return k ?? null;
}

export async function 发申请(云: 传输, x: { device: string; pubKey: string; label: string }): Promise<{ id: string; status: string }> {
  const r = await 云("POST", 路径, { action: "request", ...x });
  if (r.状态 !== 200) throw new Error(话(r, "申请没发出去"));
  return { id: String(r.json.id), status: String(r.json.status) };
}

export type 申请结果 = { status: "pending" | "denied" | "expired" | "removed" | "none" } | { status: "approved"; 团队: 手机团队; teamName: string };

/** 问一下电脑点了没。允许了就解开、核对是封给这台手机的，返回能直接同步的身份 */
export async function 查申请(云: 传输, 本机: { device: string; 私钥: 密.设备私钥 }): Promise<申请结果> {
  const r = await 云("POST", 路径, { action: "status" });
  if (r.状态 !== 200) throw new Error(话(r, "查不到授权结果"));
  const status = String(r.json.status);
  if (status !== "approved") return { status: status as "pending" };
  const 内容 = JSON.parse(await 密.拆自(本机.私钥, String(r.json.sealed ?? ""))) as {
    v: number; teamId: string; teamName: string; device: string; key: string; epoch: number; keys: 密.钥匙环; signPub?: string; userId: string;
  };
  if (内容.v !== 1 || 内容.device !== 本机.device || 内容.teamId !== r.json.teamId) throw new Error("授权内容对不上这台手机，请在电脑上重新授权");
  return {
    status: "approved",
    teamName: 内容.teamName,
    团队: { teamId: 内容.teamId, device: 本机.device, key: 内容.key, epoch: 内容.epoch, keys: 内容.keys ?? {}, signPub: 内容.signPub, userId: 内容.userId, 私钥: 本机.私钥 },
  };
}

/* ---------------- 手机批准本人的新设备（2026-10-15，0.46.17） ----------------
 * 已经连上团队的手机也能点「允许」：本人的新电脑、新手机登录同一个账号发了申请，手机上弹出来，和电脑上的授权框一个意思。
 * 和电脑批准（lib/sync/mobile-desktop.ts 允许手机）同一套：领挑战（服务端用这台手机登记的公钥封随机数，手机私钥解开交回，
 * 证明是团队里的这台手机）→ 把团队钥匙环封给新设备的公钥交上去。服务端只转交、解不开。
 *
 * 和电脑批准的两处不同（10-15 定）：
 *   - **老板的签名钥匙不在手机上**，所以手机批准的新电脑管不了团队（移除同事、换邀请码），新电脑上写明要在建团队的那台电脑或它授权的电脑上批才有
 *   - 入队口令也不在手机上：封给新电脑的 joinSecret 是空的（新电脑那头照样能同步，只是老板的那台看不到邀请码）
 * 只能批本人的设备：服务端按账号列、按账号核（老板也替不了业务员点）。
 */
export const 是电脑设备 = (device: string) => /^d[0-9a-f]{12}$/.test(device);
export type 待授权 = { id: string; label: string; device: string; pubKey: string; createdAt: string; 配对数字: string; 电脑: boolean };

export async function 待授权的(云: 传输): Promise<待授权[]> {
  const r = await 云("POST", 路径, { action: "pending" });
  if (r.状态 !== 200) throw new Error(话(r, "查不到待授权的设备"));
  const links = (r.json.links as { id: string; label: string; device: string; pubKey: string; createdAt: string }[]) ?? [];
  return Promise.all(links.map(async (l) => ({ id: l.id, label: l.label, device: String(l.device), pubKey: l.pubKey, createdAt: String(l.createdAt), 配对数字: await 密.配对数字(l.pubKey), 电脑: 是电脑设备(String(l.device)) })));
}

/** 手机点了允许。团队 是这台手机现在的身份（钥匙要是最新的：调用前先同步一轮，或者在这里先取一次钥匙） */
export async function 允许设备(云: 传输, 团队: 手机团队, teamName: string, id: string): Promise<void> {
  const 列 = await 待授权的(云);
  const 它 = 列.find((x) => x.id === id);
  if (!它) throw new Error("这条申请不在了（可能过期了），请在新设备上重新申请");
  const ch = await 云("POST", 路径, { action: "challenge", id, teamId: 团队.teamId, device: 团队.device });
  if (ch.状态 !== 200) throw new Error(话(ch, "没能确认这台手机"));
  let nonce: string;
  try { nonce = await 密.拆自(团队.私钥, String(ch.json.challenge ?? "")); } catch { throw new Error("没能确认这台手机（挑战解不开），请重试"); }
  const 内容 = { v: 1, teamId: 团队.teamId, teamName, device: 它.device, key: 团队.key, epoch: 团队.epoch, keys: 团队.keys ?? {}, signPub: 团队.signPub, userId: 团队.userId };
  // 给电脑的多一个 kind（新电脑那头 lib/sync/device-link.ts 认这个）；没有签名私钥、没有入队口令（见上）
  const sealed = await 密.封给(它.pubKey, JSON.stringify(它.电脑 ? { ...内容, kind: "desktop", joinSecret: "" } : 内容));
  const r = await 云("POST", 路径, { action: "approve", id, teamId: 团队.teamId, sealed, nonce });
  if (r.状态 !== 200) throw new Error(话(r, "授权没成功"));
}

export async function 拒绝设备(云: 传输, id: string): Promise<void> {
  const r = await 云("POST", 路径, { action: "deny", id });
  if (r.状态 !== 200) throw new Error(话(r, "没拒成"));
}

export type 我的一台 = { device: string; 种类: "电脑" | "手机"; label: string; 连上: string; 最近同步: string | null; 这台: boolean };
/** 「我的」里列本人的设备（服务端 lib/tenant/my-devices.ts）；这台手机按设备号再认一次 */
export async function 我的设备(云: 传输, 团队: Pick<手机团队, "teamId" | "device">): Promise<{ 设备: 我的一台[]; 上限: number }> {
  const r = await 云("POST", "/api/sync/my-devices", { action: "list", teamId: 团队.teamId });
  if (r.状态 !== 200) throw new Error(话(r, "查不到我的设备"));
  const 设备 = ((r.json.devices as 我的一台[]) ?? []).map((d) => ({ ...d, 连上: String(d.连上), 最近同步: d.最近同步 ? String(d.最近同步) : null, 这台: !!d.这台 || d.device === 团队.device }));
  return { 设备, 上限: Number(r.json.上限 ?? 3) };
}
