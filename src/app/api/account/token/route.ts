import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { verifyAccount } from "@/lib/tenant/accounts";
import { 签发 } from "@/lib/tenant/device-token";
import { 结算赠送, 余额 } from "@/lib/tenant/credits";
import { 检查限流, 记一次失败, 清除限流, 解析来源IP, 阈值, IP阈值 } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 桌面端登录：手机号/邮箱 + 密码 → 一枚长期设备令牌。
 *
 * 桌面端不走网页那套会话 cookie：它的数据在用户自己机器上，连云端只为调模型网关，
 * 而网关认的是「像 API Key 一样的令牌」。这里就是发这枚令牌的地方。
 *
 * 限流两档，理由和登录页一样：按账号严（打错密码只伤到本人），按 IP 松
 * （整个办公室共用一个出口 IP，定严了会变成"一个同事手滑，全公司登不上"）。
 */
export async function POST(req: Request) {
  if (!multiTenant()) return NextResponse.json({ error: "这个部署没有账号体系" }, { status: 404 });

  let body: { target?: string; password?: string; name?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const target = (body.target ?? "").trim();
  const password = body.password ?? "";
  if (!target || !password) return NextResponse.json({ error: "请填手机号（或邮箱）和密码" }, { status: 400 });

  const ip = 解析来源IP(req.headers.get("x-forwarded-for"));
  const keys: [string, number][] = [[`token:${target.toLowerCase()}`, 阈值]];
  if (ip) keys.push([`token-ip:${ip}`, IP阈值]);
  for (const [k] of keys) {
    const 还要等 = 检查限流(k);
    if (还要等 != null) {
      return NextResponse.json({ error: `失败次数过多，请 ${Math.ceil(还要等 / 60)} 分钟后再试` }, { status: 429 });
    }
  }

  const account = await verifyAccount(target, password);
  if (!account) {
    keys.forEach(([k, 上限]) => 记一次失败(k, Date.now(), 上限));
    // 不区分「账号不存在」和「密码错」：区分开就成了查号接口
    return NextResponse.json({ error: "账号或密码不对" }, { status: 401 });
  }
  keys.forEach(([k]) => 清除限流(k));

  const { token } = await 签发(account.id, body.name?.trim() || "桌面端");
  // 顺手把注册赠送补上，桌面端第一次登录就能看到自己有多少次
  const owner = { kind: "account" as const, id: account.id };
  await 结算赠送(owner);

  return NextResponse.json({
    token,
    account: { name: account.name, contact: account.phone ?? account.email ?? "" },
    credits: await 余额(owner),
  });
}
