import { 认同步, 回 } from "@/lib/tenant/sync-auth";
import { 给拉取 } from "@/lib/tenant/sync-relay";

export const dynamic = "force-dynamic";

/** 拉序号 after 之后的批次（最多 200 批，more = 还有） */
export async function GET(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  const u = new URL(req.url);
  return 回(await 给拉取(a.accountId, u.searchParams.get("teamId") ?? "", Number(u.searchParams.get("after") ?? 0)));
}
