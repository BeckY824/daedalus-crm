import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 生成并入库, 展示 } from "@/lib/tenant/activation";

export const dynamic = "force-dynamic";

/**
 * 批量生成激活码。运营台页面里也能点，这个端点是给命令行用的：
 * 部署完在服务器上 curl 一下就能拿到一批码，不用开浏览器。
 * ADMIN_TOKEN 保护，和运营台、演示区重置同一把钥匙。
 */
export async function POST(req: Request) {
  const expected = process.env.ADMIN_TOKEN;
  if (!multiTenant() || !expected) return new NextResponse("Not Found", { status: 404 });
  const given = req.headers.get("x-admin-token") ?? new URL(req.url).searchParams.get("token");
  if (given !== expected) return new NextResponse("Forbidden", { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { count?: number; note?: string };
  const codes = await 生成并入库(body.count ?? 10, body.note);
  console.info(`[activation] 生成 ${codes.length} 个激活码${body.note ? `（${body.note}）` : ""}`);
  return NextResponse.json({ ok: true, codes: codes.map(展示) });
}
