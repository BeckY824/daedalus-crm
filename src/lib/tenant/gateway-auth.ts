import { NextResponse } from "next/server";
import { multiTenant } from "./context";
import { 读网关配置, type 网关配置 } from "../gateway";
import { 认领, 取Bearer } from "./device-token";

/**
 * 模型网关的门口。三种结果：
 *   没开网关            → 404，当这些路由不存在（自部署版、桌面端里就该是这样）
 *   令牌不对 / 被吊销   → 401
 *   通过                → 带着账号 id 和上游配置往下走
 *
 * 错误体用 OpenAI 那套 `{ error: { message } }`：调用方是标准的 OpenAI 客户端，
 * 报错能被原样显示出来，用户看到的是一句中文，而不是一串状态码。
 */

export type 认证结果 = { ok: true; cfg: 网关配置; accountId: string } | { ok: false; res: NextResponse };

export function 网关错误(status: number, message: string, extra?: Record<string, string>): NextResponse {
  return NextResponse.json({ error: { message, type: "gateway_error" } }, { status, headers: extra });
}

export async function 网关认证(req: Request): Promise<认证结果> {
  const cfg = 读网关配置();
  // 网关是托管侧的东西：它要读控制面的账号表，也要花我们的上游额度
  if (!cfg || !multiTenant()) {
    return { ok: false, res: NextResponse.json({ error: { message: "Not Found" } }, { status: 404 }) };
  }
  const who = await 认领(取Bearer(req));
  if (!who) {
    return { ok: false, res: 网关错误(401, "设备令牌无效或已被吊销，请在桌面端重新登录") };
  }
  return { ok: true, cfg, accountId: who.accountId };
}
