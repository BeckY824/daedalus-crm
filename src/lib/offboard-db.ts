import type { Prisma } from "@/generated/prisma";
import { 不掉公海的状态 } from "@/lib/pool";
import { 能进公海的阶段 } from "@/lib/project/db";

/**
 * 停用成员（离职交接，企业版 D-36，2026-10-24）：他名下的东西怎么分。停用前的清点、停用本身都按这一处分，
 * 界面上说「会转走几位、放进公海几位」和真做的对得上。
 *
 * 两种方式，默认「转交」（和原来一样，不选就不变）：
 *   转交 —— 客户、进行中的商机、没做完的计划待办、线索、渠道全给接手人；客户名下的项目整体跟着走
 *   公海 —— 客户放进客户公海（负责人不改，谁领了谁接，领的时候他没做完的活跟着领的人走，同手动放公海），
 *           他负责、挂在别人客户上的线索 / 商机阶段项目放回项目公海（进公海客户上的项目跟着客户，谁领谁带走）；
 *           线索、渠道、不在这些客户上的活照样给接手人
 *
 * 公海方式下仍然给接手人的客户：
 *   - 已签约、已流失（不掉公海的状态，同自动掉公海）
 *   - 名下有订单阶段项目的：订单阶段的项目不能放公海，只能给接手人（D-36），
 *     客户进了公海、别人一领就会把这个项目整体带走，所以客户也跟着项目给接手人
 *
 * 不管哪种方式，他负责、挂在别人客户上的项目也一起处理（原来不动，要老板一个个手动转）——
 * 一次处理完一个人名下全部。只动没结局的；有结局的是历史，同赢单丢单的商机，留在他名下
 */
export type 停用方式 = "转交" | "公海";
export const 停用方式们: readonly 停用方式[] = ["转交", "公海"];

export const 停用进公海理由 = "成员停用，放进公海";
export const 停用项目进公海理由 = "成员停用，放回项目公海";

export type 停用分拣结果 = {
  /** 负责人改成接手人的客户 */
  客户: string[];
  /** 新放进客户公海的（公海方式） */
  进公海客户: string[];
  /** 本来就在公海里、这次不动的（公海方式） */
  本来在公海: string[];
  商机: string[];
  待办: string[];
  计划: string[];
  线索: string[];
  渠道: string[];
  /** 转给接手人的项目：跟着转走的客户整体转 + 他负责、挂在别处、没结局的 */
  项目: string[];
  /** 放回项目公海的（公海方式） */
  进公海项目: string[];
  /** 公海方式下因为订单阶段只能给接手人的项目数（界面提示用；转交方式为 0） */
  订单项目: number;
};

type 读库 = Pick<Prisma.TransactionClient, "customer" | "opportunity" | "task" | "followPlan" | "lead" | "channel" | "project">;

export async function 停用分拣(db: 读库, id: string, 方式: 停用方式): Promise<停用分拣结果> {
  const 公海 = 方式 === "公海";
  const [客户们, 商机们, 待办们, 计划们, 线索们, 渠道们, 他的项目] = await Promise.all([
    db.customer.findMany({ where: { salesOwnerId: id }, select: { id: true, followStatus: true, pool: { select: { customerId: true } } } }),
    db.opportunity.findMany({ where: { ownerId: id, status: "OPEN" }, select: { id: true, customerId: true } }),
    db.task.findMany({ where: { ownerId: id, done: false }, select: { id: true, customerId: true } }),
    db.followPlan.findMany({ where: { ownerId: id, done: false }, select: { id: true, customerId: true } }),
    db.lead.findMany({ where: { ownerId: id }, select: { id: true } }),
    db.channel.findMany({ where: { channelOwnerId: id }, select: { id: true } }),
    db.project.findMany({ where: { ownerId: id, pooledAt: null, result: null }, select: { id: true, customerId: true, phase: true } }),
  ]);
  const 可进公海阶段 = 能进公海的阶段 as readonly string[];

  let 留给接手人 = 客户们;
  let 去公海: typeof 客户们 = [];
  if (公海 && 客户们.length) {
    const 有订单 = new Set((await db.project.findMany({
      where: { customerId: { in: 客户们.map((c) => c.id) }, pooledAt: null, phase: { notIn: [...可进公海阶段] } },
      select: { customerId: true },
    })).map((p) => p.customerId));
    const 留 = (c: (typeof 客户们)[number]) => 不掉公海的状态.includes(c.followStatus) || 有订单.has(c.id);
    留给接手人 = 客户们.filter(留);
    去公海 = 客户们.filter((c) => !留(c));
  }
  const 去公海的 = new Set(去公海.map((c) => c.id));
  const 转走的客户 = new Set(留给接手人.map((c) => c.id));
  // 公海方式：挂在进公海客户上的活留在他名下，谁领客户谁带走（同手动放公海）
  const 给接手人 = (rows: { id: string; customerId: string | null }[]) => rows.filter((r) => !r.customerId || !去公海的.has(r.customerId)).map((r) => r.id);

  const 跟客户走 = 转走的客户.size
    ? (await db.project.findMany({ where: { customerId: { in: [...转走的客户] }, pooledAt: null }, select: { id: true } })).map((p) => p.id)
    : [];
  // 进公海客户上的项目跟客户待在一起：谁领客户谁整体带走（同转客户），不单独放项目公海
  const 别处的 = 他的项目.filter((p) => !转走的客户.has(p.customerId) && !去公海的.has(p.customerId));
  const 进公海项目 = 公海 ? 别处的.filter((p) => 可进公海阶段.includes(p.phase)).map((p) => p.id) : [];
  const 进公海项目集 = new Set(进公海项目);
  const 项目 = [...new Set([...跟客户走, ...别处的.filter((p) => !进公海项目集.has(p.id)).map((p) => p.id)])];

  return {
    客户: [...转走的客户],
    进公海客户: 去公海.filter((c) => !c.pool).map((c) => c.id),
    本来在公海: 去公海.filter((c) => c.pool).map((c) => c.id),
    商机: 给接手人(商机们),
    待办: 给接手人(待办们),
    计划: 给接手人(计划们),
    线索: 线索们.map((r) => r.id),
    渠道: 渠道们.map((r) => r.id),
    项目,
    进公海项目,
    订单项目: 公海 ? 他的项目.filter((p) => !可进公海阶段.includes(p.phase)).length : 0,
  };
}
