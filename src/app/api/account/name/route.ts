import { 认同步, 回 } from "@/lib/tenant/sync-auth";
import { 取账号名, 改账号名 } from "@/lib/tenant/account-name";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 云端账号名（lib/tenant/account-name.ts）。按桌面端 / 手机的设备令牌认人，只读得到、只改得了自己的。
 * GET：现在的名字（桌面端建团队、连电脑前先对一次）；POST { name }：改名字。
 */
export async function GET(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  return 回(await 取账号名(a.accountId));
}

export async function POST(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  const b = (await req.json().catch(() => null)) as { name?: unknown } | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  return 回(await 改账号名(a.accountId, b.name));
}
