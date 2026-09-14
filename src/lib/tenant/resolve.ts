import { cookies } from "next/headers";
import { jwtVerify } from "jose";
import { readSecret } from "../secret";
import { resolveTenant } from "./workspaces";
import { 会话已作废 } from "./session-cutoff";
import type { TenantContext } from "./context";

/**
 * 从当前请求的会话里解析出工作区。
 *
 * 这是托管版租户路由的唯一入口，也是几次试错之后留下的那个方案。记下为什么：
 *
 *   AsyncLocalStorage 走不通——enterWith 只在**当前函数**里持续，跨不了
 *   函数边界（实测：被调用的深处 enter 完，调用方拿到的是 undefined）。
 *   而 Next 没有一个能包住整个请求的调用点：服务端组件、Server Action、
 *   路由处理器是三种各自独立的入口，run(callback) 无处可放。
 *
 *   React 的 cache() 也只覆盖了 RSC 渲染——实测 Server Action 与路由处理器里
 *   每次调用都拿到新对象，存不住东西。
 *
 * 最后用的办法是：**不在取属性时解析，在调用方法时解析**。
 * prisma.customer.findMany() 本来就返回 Promise，那一刻做异步解析完全来得及，
 * 而 cookies() 在三种入口里都能用。于是 34 处 import 一个都不用改。
 *
 * 按 token 缓存一小会儿，避免每条查询都验一次 JWT、查一次控制面库。
 * token 本身就是身份，拿它做 key 不会串到别人头上。
 */
const SECRET = new TextEncoder().encode(readSecret());
const COOKIE = "crm_session";

/**
 * 缓存 10 秒。短到试用刚过期时最多多写 10 秒，长到一个页面里几十条查询只解析一次。
 * 想更准就把 writable 拆出来单独查，但那样每条查询都要碰一次控制面库，不值。
 */
const TTL_MS = 10_000;
const MAX = 500;

type Entry = { ctx: TenantContext | null; at: number };
const globalForResolve = globalThis as unknown as { tenantByToken: Map<string, Entry> | undefined };
const cache = (globalForResolve.tenantByToken ??= new Map<string, Entry>());

export function clearTenantCache(token?: string) {
  if (token) cache.delete(token);
  else cache.clear();
}

export async function resolveCurrentTenant(): Promise<TenantContext | null> {
  let token: string | undefined;
  try {
    token = (await cookies()).get(COOKIE)?.value;
  } catch {
    // 不在请求上下文里（脚本、构建期）。调用方会给出更清楚的报错
    return null;
  }
  if (!token) return null;

  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ctx;

  let ctx: TenantContext | null = null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    const accountId = payload.sub as string | undefined;
    const ws = typeof payload.ws === "string" ? payload.ws : "";
    /**
     * 改过密码之后，签发在改密之前的票据解析不出工作区——于是拿着旧 Cookie 的人
     * 连库都开不了。这一道必须在**这里**，不能只放在 getCurrentUser：
     * 那个只有页面和显式调它的动作会走，而 prisma.ts 是直接问这里要工作区的，
     * 「布局校验过所以动作安全」正是这套代码反复提防的那类越权。
     *
     * 代价是这里有 10 秒缓存，最坏情况下旧会话还能多活 10 秒（同试用到期那条）。
     * 想立刻生效的那一份在 getCurrentUser 里，不走缓存。
     */
    const 作废 = accountId ? await 会话已作废(accountId, typeof payload.iat === "number" ? payload.iat : undefined) : true;
    if (accountId && ws && !作废) ctx = await resolveTenant(accountId, ws);
  } catch {
    ctx = null;
  }

  // 简单的容量上限：满了就清空。这是缓存不是状态，清掉只损失一次解析
  if (cache.size >= MAX) cache.clear();
  cache.set(token, { ctx, at: Date.now() });
  return ctx;
}
