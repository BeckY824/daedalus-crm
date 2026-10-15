import { 认同步, 回 } from "@/lib/tenant/sync-auth";
import { 我的设备, 移除我的设备 } from "@/lib/tenant/my-devices";

export const dynamic = "force-dynamic";

/**
 * 我的设备（lib/tenant/my-devices.ts）：action = list（teamId）| remove（teamId、device）。
 * 按令牌认账号：只看得到、只移除得了自己的；正在用的这台（同一枚令牌）不能在这里移除
 */
export async function POST(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  const b = (await req.json().catch(() => ({}))) as { action?: string; teamId?: string; device?: string };
  if (b.action === "list") return 回(await 我的设备(a.accountId, String(b.teamId ?? ""), a.tokenId));
  if (b.action === "remove") return 回(await 移除我的设备(a.accountId, String(b.teamId ?? ""), String(b.device ?? ""), a.tokenId));
  return Response.json({ error: "不认识的操作" }, { status: 400 });
}
