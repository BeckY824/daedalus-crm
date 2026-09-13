import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 当前请求属于哪个工作区。
 *
 * 托管版一个进程服务所有租户，业务代码里的 `prisma` 必须解析到「这个请求」的那个库。
 * 用 AsyncLocalStorage 而不是显式传参：34 处 import 一个都不用改，
 * 漏传的风险也就不存在——没有 run 过就没有上下文，取不到就是取不到，不会串到别人库里。
 *
 * 单租户（自部署）模式下永远没人调 runWithTenant，currentTenant() 恒为 null，
 * prisma 代理落回默认那一个客户端，行为和改造前完全一致。
 */
export type TenantContext = {
  workspaceId: string;
  slug: string;
  /** 业务库文件名，相对 WORKSPACE_DIR */
  dbFile: string;
  /** 当前登录人在这个工作区里的角色 */
  role: string;
  /** 试用 / 订阅是否还在有效期内。过期后所有写操作要被拦住 */
  writable: boolean;
};

const storage = new AsyncLocalStorage<TenantContext>();

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentTenant(): TenantContext | null {
  return storage.getStore() ?? null;
}

/**
 * 把工作区写进当前异步上下文，之后这个请求里的所有代码都能取到。
 *
 * 用 enterWith 而不是 run(callback)：Next 没有一个能把「整个请求」包起来的
 * 调用点——服务端组件、Server Action、路由处理器是各自独立的入口。而每个入口
 * 都以 requireUser() 开头（27 个文件无一例外），在那里 enterWith 一次，
 * 下游全都看得到。Next 给每个请求独立的异步上下文，不会串到别的请求去。
 */
export function enterTenant(ctx: TenantContext): void {
  storage.enterWith(ctx);
}

/**
 * 取当前工作区，没有就抛错。
 * 用在「只有托管版才会走到」的路径上，比如工作区设置页；
 * 业务代码不要用它——业务代码应该对单 / 多租户无感。
 */
export function requireTenant(): TenantContext {
  const t = currentTenant();
  if (!t) throw new Error("当前请求没有工作区上下文");
  return t;
}

/** 托管版开关。只认显式的 "1"，避免误开 */
export function multiTenant(): boolean {
  return process.env.MULTI_TENANT === "1";
}
