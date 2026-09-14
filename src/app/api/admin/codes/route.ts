import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 生成并入库, 生成演示码, 换万能码, 展示 } from "@/lib/tenant/activation";

export const dynamic = "force-dynamic";

/**
 * 生成码。运营台页面里也能点，这个端点是给命令行用的：
 * 部署完在服务器上 curl 一下就能拿到一批码，不用开浏览器。
 * ADMIN_TOKEN 保护，和运营台、演示区重置同一把钥匙。
 *
 * body.kind：
 *   once（默认）一次性邀请码，注册时填了多送 AI 次数，用一次作废
 *   demo        演示码，进 /demo 用，一码一个浏览器
 *   master      换一个万能邀请码（旧码立刻作废），count 无意义
 */
export async function POST(req: Request) {
  const expected = process.env.ADMIN_TOKEN;
  if (!multiTenant() || !expected) return new NextResponse("Not Found", { status: 404 });
  const given = req.headers.get("x-admin-token") ?? new URL(req.url).searchParams.get("token");
  if (given !== expected) return new NextResponse("Forbidden", { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { count?: number; note?: string; kind?: "once" | "demo" | "master" };
  const kind = body.kind ?? "once";
  if (kind === "master") {
    const code = await 换万能码();
    console.info("[activation] 万能邀请码已更换");
    return NextResponse.json({ ok: true, codes: [展示(code)] });
  }
  const codes = kind === "demo" ? await 生成演示码(body.count ?? 10, body.note) : await 生成并入库(body.count ?? 10, body.note);
  console.info(`[activation] 生成 ${codes.length} 个${kind === "demo" ? "演示码" : "一次性邀请码"}${body.note ? `（${body.note}）` : ""}`);
  return NextResponse.json({ ok: true, codes: codes.map(展示) });
}
