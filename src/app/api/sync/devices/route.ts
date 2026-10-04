import { 认同步, 回 } from "@/lib/tenant/sync-auth";
import { 团队设备 } from "@/lib/tenant/sync-relay";

export const dynamic = "force-dynamic";

/** 换钥匙前取在册设备的公钥（只有建团队的人）。?teamId= */
export async function GET(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  return 回(await 团队设备(a.accountId, new URL(req.url).searchParams.get("teamId") ?? ""));
}
