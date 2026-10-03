import { NextResponse } from "next/server";
import { multiTenant } from "./context";
import { 认领, 取Bearer } from "./device-token";

/**
 * 团队同步接口的门（2026-10-03）：只在托管版（我们的云）上有；认桌面端那枚设备令牌（dk_…），和模型网关同一枚。
 * 不走网关认证：那一个还绑着网关配置，同步和模型无关。
 */
export async function 认同步(req: Request): Promise<{ ok: true; accountId: string } | { ok: false; res: NextResponse }> {
  if (!multiTenant()) return { ok: false, res: new NextResponse("Not Found", { status: 404 }) };
  const t = await 认领(取Bearer(req));
  if (!t) return { ok: false, res: NextResponse.json({ error: "登录已失效，请重新登录" }, { status: 401 }) };
  return { ok: true, accountId: t.accountId };
}

export function 回(r: { ok: true } | { ok: false; 状态: number; error: string }) {
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.状态 });
  return NextResponse.json(r);
}
