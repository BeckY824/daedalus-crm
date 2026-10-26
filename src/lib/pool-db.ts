/**
 * 公海读写（2026-10-03，0.46.15 第 6 块）。规矩和说法在 lib/pool.ts；按钮背后的动作在 customers/pool-actions.ts。
 */
import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { getBusiness } from "@/lib/business";
import { getSetting, setSetting } from "@/lib/settings";
import { recordAudit } from "@/lib/audit";
import { 读团队 } from "@/lib/sync/client";
import { 看全部 } from "@/lib/team-scope";
import { dayjs } from "@/lib/utils";
import { 不掉公海的状态, 公海截止, 自动理由 } from "@/lib/pool";

/** 本机记的「今天扫过了」。不进团队同步（同步的设置 只有 business），每台各扫各的 */
const 扫过键 = "poolSweptOn";

/**
 * N 天没跟进的自动放进公海。业务配置里没开（poolDays = 0）就什么都不做；一天最多扫一次。
 * 客户页、首页加载时调，扫出来的当场就能在列表上看到。
 *
 * **团队模式下每台只扫自己名下的**：自己的跟进本机最全。扫别人的，可能同事刚写的跟进还没拉到，
 * 就把他正在谈的人扔进了公海。一个库多人（托管版、自部署）大家看的是同一份数据，扫全部。
 *
 * 扫多大一片只看 读团队()，不看打开页面的人看得到多少（D12，同项目超时回收 Y18）：查、写都包在 看全部() 里。
 * 原来不包：企业版按组织看客户开着时，请求带着打开页面那个人的范围，低权限的人先打开，只扫到自己 + 下属的客户，
 * 却记成「全公司今天扫过了」，别人名下该掉的当天都不掉；团队版业务员（互看关着）先打开也一样只扫到自己的。
 * 「今天扫过了」也只记扫过的那一片：团队模式只扫了自己名下的，记在自己的号上（同 Y18），不挡同一台上别人
 */
export async function 自动掉公海(me: { id: string; name: string }, 今: Date = new Date()): Promise<number> {
  return 看全部(() => 按天扫(me, 今));
}

async function 按天扫(me: { id: string; name: string }, 今: Date): Promise<number> {
  const b = await getBusiness();
  if (!b.poolDays) return 0;
  const 今天 = dayjs(今).format("YYYY-MM-DD");
  const 只扫 = 读团队() ? me.id : undefined;
  const 键 = 只扫 ? `${扫过键}:${只扫}` : 扫过键;
  if ((await getSetting<string>(键)) === 今天) return 0;

  const 截止 = 公海截止(b.poolDays, 今);
  const 要掉 = await prisma.customer.findMany({
    where: {
      pool: null,
      followStatus: { notIn: [...不掉公海的状态] },
      ...(只扫 ? { salesOwnerId: 只扫 } : {}),
      OR: [{ lastFollowAt: { lt: 截止 } }, { lastFollowAt: null, createdAt: { lt: 截止 } }],
      // 领走以后也从领的那天重新算：领走当天没跟进，第二天不会又被扫回去（复查）
      AND: [{ OR: [{ claim: null }, { claim: { at: { lt: 截止 } } }] }],
    },
    select: { id: true },
  });
  if (要掉.length) {
    const 理由 = 自动理由(b.poolDays);
    const 行 = 要掉.map((c) => ({ customerId: c.id, reason: 理由, at: 今 }));
    // 两个页面同时加载、一起扫到同一位时会撞主键（SQLite 上 Prisma 没有 skipDuplicates）：撞了就逐条补
    await prisma.customerPool.createMany({ data: 行 }).catch(async () => {
      for (const r of 行) await prisma.customerPool.upsert({ where: { customerId: r.customerId }, update: {}, create: r });
    });
    await recordAudit({
      user: me, action: "pool", entity: "Customer",
      summary: `${要掉.length} 名${b.customer}${b.poolDays} 天没跟进，自动放进公海`,
      detail: { ids: 要掉.map((c) => c.id), poolDays: b.poolDays },
    });
  }
  await setSetting(键, 今天);
  return 要掉.length;
}

/**
 * 这一次渲染看得到的客户总数（带限定）。左栏「客户」角标和客户页页签用同一个数：React 的 cache() 让同一次
 * RSC 渲染里只数一遍（Server Action、路由处理器里它不缓存，每次照数）。企业版开了按组织看客户时，
 * 带范围的客户计数要 Customer LEFT JOIN CustomerPool 全表扫一遍，10 倍数据一次 ~20 ms（2026-10-26 企业版 p95）
 */
export const 客户总数 = cache(() => prisma.customer.count());

/**
 * 客户页两个页签上的数（不带筛选）：「客户」= 不在公海的，「公海」= 在公海的。和左栏「客户」角标同一套限定，两数相加 = 角标。
 *
 * 不拿 `pool: { is / isNot: null }` 去数：Prisma 把它展开成 Customer LEFT JOIN CustomerPool 再套一层子查询，
 * 10 万客户一次 ~10 ms，限定了（业务员、企业版按组织看）还要全表扫，一次 20–30 ms，每次进客户页要数两遍（2026-10-25/26 企业版 p95）。
 * 改成全部客户（和角标同一个数）减公海表条数。限定了也对得上：公海表按「挂在看得到的客户上」限定，
 * 而看得到的客户里本来就含整个公海（可见客户 的第三条），所以带限定数出来的公海表 = 全部公海，
 * 带限定的全部客户 = 看得到的非公海 + 全部公海；互看读两边都不限定。公海表的 customerId 是外键、删客户连带删
 */
export async function 客户页签数(): Promise<{ 公海: number; 非公海: number }> {
  const [全部, 公海] = await Promise.all([客户总数(), prisma.customerPool.count()]);
  return { 公海, 非公海: 全部 - 公海 };
}
