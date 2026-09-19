import { NextResponse } from "next/server";
import { 网关认证 } from "@/lib/tenant/gateway-auth";
import { 余额, 结算赠送, 每日赠送 } from "@/lib/tenant/credits";

export const dynamic = "force-dynamic";

/**
 * 还剩几次。不是 OpenAI 的接口，是桌面端用来显示额度的。
 * 顺带把当天的赠送结掉——用户打开应用看一眼额度，就算"今天用了"。
 *
 * **这一处只结每日赠送，不发注册赠送**（2026-09-19）。
 *
 * 注册赠送从这天起一台机器只发一次，而这个接口只认一枚令牌、拿不到是哪台机器
 * （网关认证给的是 accountId，就这一样）。所以 结算赠送() 这里**故意不传机器**——
 * 在账本那边「不知道是哪台机器」= 不发注册赠送。
 *
 * 想清楚的是反过来那条路有多糟：要是这里照旧补注册赠送，那么登录接口上那道
 * 「这台电脑领过了」的闸门就形同虚设——同一台电脑上注册第二个账号，
 * 登录时没领到，**打开应用看一眼额度就补上了**。整件事等于没做，
 * 而且是从一个和"机器"八竿子打不着的接口漏出去的，最不容易想到。
 *
 * 代价是零：桌面端必须先过登录接口才拿得到令牌，注册赠送在那一步就结过了。
 * 也就是说走到这里的账号，该有的那份早就在账上；这里补不补都一样。
 */
export async function GET(req: Request) {
  const auth = await 网关认证(req);
  if (!auth.ok) return auth.res;
  const owner = { kind: "account" as const, id: auth.accountId };
  await 结算赠送(owner);
  /*
    `accountId` 是 0.39.2 加的。桌面端每次启动都用这个接口验一遍令牌还认不认，
    顺手把「你是谁」带回去——**升级上来的老安装靠它认领自己那份数据**：
    它的 .cloud.json 是旧版写的，里面没有账号 id，而人不会为了升级再登录一次。
  */
  return NextResponse.json({ ...(await 余额(owner)), 每日赠送, accountId: auth.accountId });
}
