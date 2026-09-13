import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 当前请求属于哪个工作区。
 *
 * 注意 runWithTenant 只是一个**可选的加速路径**：显式包起来的代码段（认证、测试、
 * 后台脚本）里，prisma 不用再去读 cookie 解析一遍。真正的租户路由发生在
 * tenant/resolve.ts，每次数据库调用时按会话解析——那里写了为什么不能只靠 ALS。
 *
 * 单租户（自部署）模式下没人会用到这里，prisma 直接走默认客户端。
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
