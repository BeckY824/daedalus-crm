import { 认同步, 回 } from "@/lib/tenant/sync-auth";
import { 取钥匙 } from "@/lib/tenant/sync-relay";

export const dynamic = "force-dynamic";

/** 取钥匙：现在第几把、封给这台设备的那份、钥匙环。?teamId=&device= */
export async function GET(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  const u = new URL(req.url);
  return 回(await 取钥匙(a.accountId, u.searchParams.get("teamId") ?? "", u.searchParams.get("device") ?? ""));
}
