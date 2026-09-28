import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 用进门码, 签运营票, 运营COOKIE, 运营票秒, 票要HTTPS } from "@/lib/ops-auth";

export const dynamic = "force-dynamic";

/**
 * 进门码 → 运营台票（12 小时，httpOnly）→ 跳到 /admin。
 * 码不对、过期、用过了：一律 404，和运营台别的门一样，不告诉人这里有东西。
 * 票只挂在 /admin 下面：业务页面、API 都收不到它。
 */
export async function GET(req: Request) {
  if (!multiTenant()) return new NextResponse("Not Found", { status: 404 });
  const accountId = 用进门码(new URL(req.url).searchParams.get("code"));
  if (!accountId) return new NextResponse("Not Found", { status: 404 });
  // 相对地址跳：和 /api/desktop/session 一个道理，不把 req.url 里的主机名拼回去
  const res = new NextResponse(null, { status: 303, headers: { Location: "/admin" } });
  res.cookies.set(运营COOKIE, await 签运营票(accountId), {
    httpOnly: true,
    sameSite: "lax",
    secure: 票要HTTPS(),
    path: "/admin",
    maxAge: 运营票秒,
  });
  return res;
}
