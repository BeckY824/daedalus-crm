import { NextResponse } from "next/server";
import { 认同步, 回 } from "@/lib/tenant/sync-auth";
import { 建团队, 我的团队 } from "@/lib/tenant/sync-relay";

export const dynamic = "force-dynamic";

/** 我在的团队（成员、开通了没有） */
export async function GET(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  return NextResponse.json({ ok: true, teams: await 我的团队(a.accountId) });
}

/** 建团队：回团队编号和入队口令（钥匙在桌面端本机生成，不经过这里） */
export async function POST(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  return 回(await 建团队(a.accountId, String(body.name ?? "")));
}
