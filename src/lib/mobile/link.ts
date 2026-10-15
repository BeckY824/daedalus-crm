/**
 * 手机这一头的「连团队」（2026-10-15，手机端方案 3.2）。电脑那头见 lib/sync/mobile-desktop.ts，中转见 lib/tenant/mobile-link.ts。
 *   1. 账号密码登录拿到令牌（页面那边做）
 *   2. 生成不可导出的 X25519 钥匙对 + 设备编号，发申请，屏幕上显示配对数字
 *   3. 轮询：电脑点了允许就拿到封好的那份，用私钥解开 → 手机团队，开始同步
 */
import * as 密 from "@/lib/sync/crypto-web";
import type { 传输, 手机团队 } from "./sync";

const 路径 = "/api/mobile/link";
const 话 = (r: { 状态: number; json: Record<string, unknown> }, 默认: string) => String(r.json.error ?? `${默认}（${r.状态}）`);

export function 新设备号(): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return "m_" + 密.转b64u(b);
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
