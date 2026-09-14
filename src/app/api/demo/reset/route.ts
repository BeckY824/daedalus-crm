import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { demoSlug, 确保演示工作区, 重置演示工作区 } from "@/lib/demo/workspace";

export const dynamic = "force-dynamic";

/**
 * 重建演示数据。幂等：没建过就建，建过就清空重灌。
 *
 * 为什么是一个 HTTP 端点而不是一个脚本：换库文件之前必须先断开应用里那个
 * 缓存着的 Prisma 客户端（见 重置演示工作区 的注释）。外部脚本够不着那个
 * 进程内的缓存，只能重启容器；走端点就在同一个进程里，断连接和换文件是连着的。
 *
 * 用 ADMIN_TOKEN 保护，和运营台同一把钥匙——能重置演示区的人本来就等于运营。
 */
export async function POST(req: Request) {
  const expected = process.env.ADMIN_TOKEN;
  if (!multiTenant() || !expected || !demoSlug()) {
    return new NextResponse("Not Found", { status: 404 });
  }
  const given = req.headers.get("x-admin-token") ?? new URL(req.url).searchParams.get("token");
  if (given !== expected) return new NextResponse("Forbidden", { status: 403 });

  try {
    const { created, counts } = await 确保演示工作区();
    const 结果 = created ? counts : await 重置演示工作区();
    console.info(`[demo] ${created ? "已建立" : "已重置"} ${demoSlug()}`, 结果);
    return NextResponse.json({ ok: true, action: created ? "created" : "reset", counts: 结果 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[demo] 重置失败：", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
