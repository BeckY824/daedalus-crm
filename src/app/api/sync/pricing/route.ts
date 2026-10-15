import { NextResponse } from "next/server";
import { 认同步 } from "@/lib/tenant/sync-auth";
import { 公开价格 } from "@/lib/tenant/team-plan";

export const dynamic = "force-dynamic";

/**
 * 团队版价格表（每人，2026-10-15）：桌面端「设置 → 团队」显示用。价格存服务器、运营台改，改了不用发版。
 * 开通 / 续费不在这里：私信我们，运营者在运营台手动开
 */
export async function GET(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  return NextResponse.json({ ok: true, ...(await 公开价格()) });
}
