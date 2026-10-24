import { prisma, defaultClient } from "@/lib/prisma";
import { 同事的客户, 只读错误 } from "@/lib/team-scope";
import { 订单 } from "@/lib/features";
import type { 归属 } from "@/lib/attachment-rules";

/** ?opportunityId= 或 ?orderId=，二选一 */
export function 读归属(q: URLSearchParams): 归属 | null {
  const 商机 = q.get("opportunityId");
  const 单 = q.get("orderId");
  const 好 = (s: string | null): s is string => !!s && /^[\w-]{1,64}$/.test(s);
  if (好(商机) && !单) return { opportunityId: 商机 };
  if (好(单) && !商机) return { orderId: 单 };
  return null;
}

/**
 * 附件跟着它挂的商机 / 订单走权限：用加了限定的 prisma 去取那一条——业务员看不到的商机 / 订单，它的附件也看不到。
 * 要改（传、删）时再挡同事的客户（团队互看时只能看）。返回给日志用的一句「商机「xx」」，不行就回一句人话
 */
export async function 认父记录(挂在: 归属, 要改: boolean): Promise<{ 叫法: string } | { 错: string; 状态: number }> {
  let 客户: string;
  let 叫法: string;
  if ("opportunityId" in 挂在) {
    const o = await prisma.opportunity.findFirst({ where: { id: 挂在.opportunityId }, select: { name: true, customerId: true } });
    if (!o) return { 错: "这个商机已经不在了，刷新看看", 状态: 404 };
    客户 = o.customerId;
    叫法 = `商机「${o.name}」`;
  } else {
    if (!订单) return { 错: "此版本未开放订单功能", 状态: 404 };
    const o = await prisma.tradeOrder.findFirst({ where: { id: 挂在.orderId }, select: { no: true, customerId: true } });
    if (!o) return { 错: "这张订单已经不在了，刷新看看", 状态: 404 };
    客户 = o.customerId;
    叫法 = `订单 ${o.no}`;
  }
  if (要改 && await 同事的客户(defaultClient, 客户)) return { 错: new 只读错误().message, 状态: 403 };
  return { 叫法 };
}
