import { NextResponse } from "next/server";
import { 网关认证 } from "@/lib/tenant/gateway-auth";

export const dynamic = "force-dynamic";

/**
 * 可用模型。OpenAI 的 /models 接口形状（data[].id，外加我们的 note）；
 * 桌面端登录云端账号后由 lib/desktop/cloud.ts 取来，填模型下拉。
 *
 * 返回的是我们的白名单，不是上游的全量列表：网关花的是我们的钱，
 * 让客户端看到并挑选任意模型，等于把成本控制交给了客户端。
 */
export async function GET(req: Request) {
  const auth = await 网关认证(req);
  if (!auth.ok) return auth.res;
  return NextResponse.json({
    object: "list",
    data: auth.cfg.models.map((m) => ({ id: m.id, object: "model", owned_by: "daedalus", note: m.note })),
  });
}
