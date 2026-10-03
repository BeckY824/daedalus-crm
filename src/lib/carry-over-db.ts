import { prisma } from "@/lib/prisma";
import type { 带走数 } from "@/lib/carry-over";

/**
 * 客户换了销售负责人，原负责人在他身上**没做完的活**跟着走（2026-10-02 排查 B3）：
 * 没完成的计划、待办，进行中的商机。原来不跟：客户转给李四以后，到点提醒、早报还发给张三，李四收不到。
 * 只动原负责人名下的——别的同事挂在这位客户上的活不碰；做完的、赢单丢单的是历史，不动。
 */
export async function 带走没做完的(换: { customerId: string; 旧: string }[], 新: string): Promise<带走数> {
  const 数: 带走数 = { 计划和待办: 0, 商机: 0 };
  for (const { customerId, 旧 } of 换) {
    if (旧 === 新) continue;
    /*
      函数式事务，不用数组式：托管版的 prisma 是按工作区解析的代理，模型方法一调就执行、返回原生 Promise，
      数组式 $transaction 收到它会直接抛错（而那几条已经写进去了）。函数式拿到的 tx 是真客户端，两边都对（2026-10-02 排查 A3）
    */
    const [计划, 待办, 商机] = await prisma.$transaction(async (tx) => [
      await tx.followPlan.updateMany({ where: { customerId, ownerId: 旧, done: false }, data: { ownerId: 新 } }),
      await tx.task.updateMany({ where: { customerId, ownerId: 旧, done: false }, data: { ownerId: 新 } }),
      await tx.opportunity.updateMany({ where: { customerId, ownerId: 旧, status: "OPEN" }, data: { ownerId: 新 } }),
    ]);
    数.计划和待办 += 计划.count + 待办.count;
    数.商机 += 商机.count;
  }
  return 数;
}
