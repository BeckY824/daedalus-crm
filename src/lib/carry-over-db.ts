import { prisma } from "@/lib/prisma";
import { 看全部 } from "@/lib/team-scope";
import type { 带走数 } from "@/lib/carry-over";

/**
 * 客户换了销售负责人，原负责人在他身上**没做完的活**跟着走（2026-10-02 排查 B3）：
 * 没完成的计划、待办，进行中的商机。原来不跟：客户转给李四以后，到点提醒、早报还发给张三，李四收不到。
 * 只动原负责人名下的——别的同事挂在这位客户上的活不碰；做完的、赢单丢单的是历史，不动。
 */
export async function 带走没做完的(换: { customerId: string; 旧: string }[], 新: string): Promise<带走数> {
  return (await 带走并记下(换, 新)).数;
}

/** 转走的是哪几条（撤销时只还这几条，不碰「转之前就归新负责人」的那些——0.46.15 公海复查） */
export type 带走的 = { 计划: string[]; 待办: string[]; 商机: string[] };

/** 同 带走没做完的，另外返回转走的那几条的 id */
export async function 带走并记下(换: { customerId: string; 旧: string }[], 新: string): Promise<{ 数: 带走数; 记下: 带走的 }> {
  const 数: 带走数 = { 计划和待办: 0, 商机: 0 };
  const 记下: 带走的 = { 计划: [], 待办: [], 商机: [] };
  for (const { customerId, 旧 } of 换) {
    if (旧 === 新) continue;
    /*
      函数式事务，不用数组式：托管版的 prisma 是按工作区解析的代理，模型方法一调就执行、返回原生 Promise，
      数组式 $transaction 收到它会直接抛错（而那几条已经写进去了）。函数式拿到的 tx 是真客户端，两边都对（2026-10-02 排查 A3）
      先取 id 再按 id 改：同一个事务里，取到的就是改掉的
    */
    /*
      看全部（团队版业务员，lib/team-scope.ts）：业务员把自己的客户交给同事，客户一换负责人他就看不到了，
      限定着查会漏掉这位客户上的商机（商机跟着客户可见），活带不过去（2026-10-04 五人实测）。要转哪几条由上面的条件定，不靠限定
    */
    const [计划, 待办, 商机] = await 看全部(() => prisma.$transaction(async (tx) => {
      const 计划 = (await tx.followPlan.findMany({ where: { customerId, ownerId: 旧, done: false }, select: { id: true } })).map((x) => x.id);
      const 待办 = (await tx.task.findMany({ where: { customerId, ownerId: 旧, done: false }, select: { id: true } })).map((x) => x.id);
      const 商机 = (await tx.opportunity.findMany({ where: { customerId, ownerId: 旧, status: "OPEN" }, select: { id: true } })).map((x) => x.id);
      if (计划.length) await tx.followPlan.updateMany({ where: { id: { in: 计划 } }, data: { ownerId: 新 } });
      if (待办.length) await tx.task.updateMany({ where: { id: { in: 待办 } }, data: { ownerId: 新 } });
      if (商机.length) await tx.opportunity.updateMany({ where: { id: { in: 商机 } }, data: { ownerId: 新 } });
      return [计划, 待办, 商机];
    }));
    数.计划和待办 += 计划.length + 待办.length;
    数.商机 += 商机.length;
    记下.计划.push(...计划);
    记下.待办.push(...待办);
    记下.商机.push(...商机);
  }
  return { 数, 记下 };
}
