import { 认同步, 回 } from "@/lib/tenant/sync-auth";
import { 入队 } from "@/lib/tenant/sync-relay";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  const body = (await req.json().catch(() => ({}))) as { teamId?: string; joinSecret?: string };
  return 回(await 入队(a.accountId, String(body.teamId ?? ""), String(body.joinSecret ?? "")));
}
