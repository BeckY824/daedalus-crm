import { NextResponse } from "next/server";
import { 网关认证 } from "@/lib/tenant/gateway-auth";

export const dynamic = "force-dynamic";

/**
 * 可用模型。OpenAI 的 /models 接口形状，桌面端设置页里那个「拉取模型列表」
 * 按钮直接就能用（llm.ts 的 fetchRemoteModels 读的就是 data[].id）。
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
