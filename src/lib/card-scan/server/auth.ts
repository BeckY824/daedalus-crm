/**
 * 扫名片几个服务器接口共用的：认人（只给团队版）、按账号限次。
 * 认字（app/api/mobile/scan）和 AI 整理（app/api/mobile/scan/ai）各有各的次数表。
 */
import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 认领, 取Bearer } from "@/lib/tenant/device-token";
import { 连手机资格 } from "@/lib/tenant/mobile-link";

const 资格缓存毫秒 = 5 * 60_000;

/** 是团队版的记 5 分钟（扫名片一张要问好几次）；不是的不记：刚开通的马上就能用 */
const 资格缓存 = new Map<string, number>();
async function 是团队版(accountId: string): Promise<boolean> {
  if ((资格缓存.get(accountId) ?? 0) > Date.now()) return true;
  const ok = (await 连手机资格(accountId)) === "ok";
  if (ok) 资格缓存.set(accountId, Date.now() + 资格缓存毫秒);
  else 资格缓存.delete(accountId);
  if (资格缓存.size > 10_000) for (const [k, 到] of 资格缓存) if (到 <= Date.now()) 资格缓存.delete(k);
  return ok;
}

/**
 * 只给登录了的团队版账号（和连手机同一条：在团队、团队开着、有自己连上的设备）。
 * 不是多租户（自部署）就当没有这个接口，手机自己认、自己拆
 */
export async function 认扫名片的人(req: Request): Promise<{ accountId: string } | NextResponse> {
  if (!multiTenant()) return new NextResponse("Not Found", { status: 404 });
  const t = await 认领(取Bearer(req));
  if (!t) return NextResponse.json({ error: "登录已失效，请重新登录" }, { status: 401 });
  if (!(await 是团队版(t.accountId))) return NextResponse.json({ error: "服务器识别只给团队版" }, { status: 403 });
  return { accountId: t.accountId };
}

/** 按账号限次（10 分钟 N 遍）。表放内存：只有一个容器，重启清空无所谓 */
export function 建限次(限次: number, 限时毫秒 = 10 * 60_000) {
  const 用过 = new Map<string, number[]>();
  /** 这个账号还能不能用（能就记一次） */
  return function 记一次(accountId: string, now = Date.now()): boolean {
    const 次们 = (用过.get(accountId) ?? []).filter((t) => now - t < 限时毫秒);
    if (次们.length >= 限次) { 用过.set(accountId, 次们); return false; }
    次们.push(now);
    用过.set(accountId, 次们);
    if (用过.size > 10_000) for (const [k, v] of 用过) if (!v.some((t) => now - t < 限时毫秒)) 用过.delete(k);
    return true;
  };
}
