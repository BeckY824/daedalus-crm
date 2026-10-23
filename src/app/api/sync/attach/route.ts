import { 认同步 } from "@/lib/tenant/sync-auth";
import { 核设备, 范围错误 } from "@/lib/tenant/sync-scoped";
import { 收附件块, 给附件, 有哪些附件, 一块上限, 附件错误 } from "@/lib/tenant/sync-attach";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 团队版附件的文件通道（2026-10-22 D-24，见 lib/tenant/sync-attach.ts）：只有密文进出。
 *   PUT  ?teamId&id&device&offset&total&head  body = 一块密文   → { have, done }；接不上回 409 + have
 *   GET  ?teamId&id&device                                      → 整份密文；没传齐回 404 + uploading
 *   POST { teamId, device, action: "have", ids }               → { have: 云端已经传齐的那些 }
 */
function 错(e: unknown, 动作: string): Response {
  if (e instanceof 范围错误) return Response.json({ error: e.message, ...(e instanceof 附件错误 ? e.补充 : {}) }, { status: e.状态 });
  console.error("[sync-attach] 请求失败", 动作, e instanceof Error ? e.name : "unknown", (e as { code?: unknown })?.code ?? "");
  return Response.json({ error: "图片通道暂不可用，请稍后重试" }, { status: 503 });
}

export async function PUT(req: Request) {
  const auth = await 认同步(req); if (!auth.ok) return auth.res;
  if (Number(req.headers.get("content-length") ?? 0) > 一块上限) return Response.json({ error: "一块太大" }, { status: 413 });
  const u = new URL(req.url);
  const q = (k: string) => u.searchParams.get(k) ?? "";
  try {
    await 核设备(auth.accountId, q("teamId"), q("device"), auth.tokenId);
    const 块 = new Uint8Array(await req.arrayBuffer());
    if (块.byteLength > 一块上限) return Response.json({ error: "一块太大" }, { status: 413 });
    return Response.json(await 收附件块(auth.accountId, q("teamId"), { id: q("id"), offset: Number(q("offset")), total: Number(q("total")), head: q("head") }, 块));
  } catch (e) {
    return 错(e, "put");
  }
}

export async function GET(req: Request) {
  const auth = await 认同步(req); if (!auth.ok) return auth.res;
  const u = new URL(req.url);
  const q = (k: string) => u.searchParams.get(k) ?? "";
  try {
    await 核设备(auth.accountId, q("teamId"), q("device"), auth.tokenId);
    const { 大小, 流 } = await 给附件(auth.accountId, q("teamId"), q("id"));
    return new Response(流, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(大小), "Cache-Control": "no-store" } });
  } catch (e) {
    return 错(e, "get");
  }
}

export async function POST(req: Request) {
  const auth = await 认同步(req); if (!auth.ok) return auth.res;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.teamId !== "string") return Response.json({ error: "请求格式不对" }, { status: 400 });
  try {
    await 核设备(auth.accountId, body.teamId, body.device, auth.tokenId);
    if (body.action === "have") return Response.json(await 有哪些附件(auth.accountId, body.teamId, body.ids));
    return Response.json({ error: "未知操作" }, { status: 400 });
  } catch (e) {
    return 错(e, String(body.action));
  }
}
