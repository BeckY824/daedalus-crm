import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 认领, 取Bearer } from "@/lib/tenant/device-token";
import { 回 } from "@/lib/tenant/sync-auth";
import { 申请, 我的申请, 待授权, 挑战, 允许, 拒绝, 已连接, 移除 } from "@/lib/tenant/mobile-link";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 手机连团队（lib/tenant/mobile-link.ts）。手机和电脑都拿各自的设备令牌来（dk_…），按 action 分：
 *   手机：request（发申请：device、pubKey、label）、status（问结果）
 *   本人已连上的电脑或手机（手机 2026-10-15 起）：pending（待授权）、challenge（id、teamId、device：领挑战）、approve（id、teamId、sealed、nonce）、deny（id）
 *   电脑：list（已连接的手机）、remove（id）
 * 都按令牌认账号：只看得到、只处理得了自己账号的手机。
 */
export async function POST(req: Request) {
  if (!multiTenant()) return new NextResponse("Not Found", { status: 404 });
  const t = await 认领(取Bearer(req));
  if (!t) return NextResponse.json({ error: "登录已失效，请重新登录" }, { status: 401 });
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
    if (!b || typeof b !== "object" || Array.isArray(b)) throw Error();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (b.action) {
    case "request": return 回(await 申请(t.accountId, t.id, { device: b.device, pubKey: b.pubKey, label: b.label }));
    case "status": return 回(await 我的申请(t.accountId, t.id));
    case "pending": return 回(await 待授权(t.accountId));
    case "challenge": return 回(await 挑战(t.accountId, s(b.id), s(b.teamId), s(b.device)));
    case "approve": return 回(await 允许(t.accountId, s(b.id), s(b.teamId), s(b.sealed), s(b.nonce)));
    case "deny": return 回(await 拒绝(t.accountId, s(b.id)));
    case "list": return 回(await 已连接(t.accountId));
    case "remove": return 回(await 移除(t.accountId, s(b.id)));
    default: return NextResponse.json({ error: "不认识的操作" }, { status: 400 });
  }
}
