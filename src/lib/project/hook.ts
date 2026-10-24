/**
 * 新建客户的同一个事务里接着建别的（项目模式的建档向导，2026-10-23）。
 *
 * saveCustomer 在 "use server" 文件里，第二个参数浏览器那边也能塞一个别的服务端动作进来；
 * 只认这里登记过的函数，塞进来的一律当没给。
 */
import type { Prisma } from "@/generated/prisma";

export type 接着建 = (tx: Prisma.TransactionClient, customerId: string) => Promise<void>;

const 登记过的 = new WeakSet<接着建>();

export function 登记接着建(fn: 接着建): 接着建 {
  登记过的.add(fn);
  return fn;
}

export function 认得(fn: unknown): fn is 接着建 {
  return typeof fn === "function" && 登记过的.has(fn as 接着建);
}
