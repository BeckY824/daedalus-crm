import { 认同步, 回 } from "@/lib/tenant/sync-auth";
import { 设互看 } from "@/lib/tenant/sync-relay";

export const dynamic = "force-dynamic";

/** 「同事之间互相看得到客户」开 / 关（只有建团队的人）。body：{ teamId, on } */
export async function POST(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  const body = (await req.json().catch(() => ({}))) as { teamId?: string; on?: boolean };
  return 回(await 设互看(a.accountId, String(body.teamId ?? ""), body.on === true));
}
