import { 认同步, 回 } from "@/lib/tenant/sync-auth";
import { 移除成员 } from "@/lib/tenant/sync-relay";

export const dynamic = "force-dynamic";

/** 移除成员（只有建团队的人）。body：{ teamId, accountId }。回新的入队口令；桌面端接着换钥匙 */
export async function POST(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  const body = (await req.json().catch(() => ({}))) as { teamId?: string; accountId?: string };
  return 回(await 移除成员(a.accountId, String(body.teamId ?? ""), String(body.accountId ?? "")));
}
