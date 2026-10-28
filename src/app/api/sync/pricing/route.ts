import { NextResponse } from "next/server";
import { 认同步 } from "@/lib/tenant/sync-auth";

export const dynamic = "force-dynamic";

/**
 * 团队版价格表：2026-10-28 起不标价（团队版免费），回空表。
 * 0.46.29 及以前的桌面端还会来读、拿到空表就不摆价格块（lib/sync/client.ts 当时的 读价格表 空表回 null），
 * 这样不用等大家升级，旧版上的价格也一起下掉。运营台的价格表和「开通 / 续费」照旧，只是不再发给桌面端
 */
export async function GET(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  return NextResponse.json({ ok: true, prices: [], trialDays: 0 });
}
