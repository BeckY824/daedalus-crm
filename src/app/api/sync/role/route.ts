import { 认同步, 回 } from "@/lib/tenant/sync-auth";
import { 设角色 } from "@/lib/tenant/sync-relay";

export const dynamic = "force-dynamic";

/** 设业务主管 / 改回业务员（只有建团队的人）。body：{ teamId, accountId, role: "manager" | "member" } */
export async function POST(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  const body = (await req.json().catch(() => ({}))) as { teamId?: string; accountId?: string; role?: string };
  return 回(await 设角色(a.accountId, String(body.teamId ?? ""), String(body.accountId ?? ""), String(body.role ?? "")));
}
