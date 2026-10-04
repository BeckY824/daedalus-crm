import { 认同步, 回 } from "@/lib/tenant/sync-auth";
import { 换口令 } from "@/lib/tenant/sync-relay";

export const dynamic = "force-dynamic";

/** 换邀请码（只有建团队的人）。body：{ teamId }。回新的入队口令；桌面端接着换钥匙 */
export async function POST(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  const body = (await req.json().catch(() => ({}))) as { teamId?: string };
  return 回(await 换口令(a.accountId, String(body.teamId ?? "")));
}
