import { 认同步, 回 } from "@/lib/tenant/sync-auth";
import { 收推送 } from "@/lib/tenant/sync-relay";

export const dynamic = "force-dynamic";

/** 推一批密文。body：{ teamId, device, data }，data 是桌面端加密好的一段 base64url */
export async function POST(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  const body = (await req.json().catch(() => ({}))) as { teamId?: string; device?: string; data?: string };
  return 回(await 收推送(a.accountId, String(body.teamId ?? ""), String(body.device ?? ""), String(body.data ?? "")));
}
