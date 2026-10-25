/**
 * 公海读写（2026-10-03，0.46.15 第 6 块）。规矩和说法在 lib/pool.ts；按钮背后的动作在 customers/pool-actions.ts。
 */
import { prisma, defaultClient } from "@/lib/prisma";
import { getBusiness } from "@/lib/business";
import { getSetting, setSetting } from "@/lib/settings";
import { recordAudit } from "@/lib/audit";
import { 读团队 } from "@/lib/sync/client";
import { dayjs } from "@/lib/utils";
import { 不掉公海的状态, 公海截止, 自动理由 } from "@/lib/pool";
import { 限定的我 } from "@/lib/team-scope";

/** 本机记的「今天扫过了」。不进团队同步（同步的设置 只有 business），每台各扫各的 */
const 扫过键 = "poolSweptOn";

/**
 * N 天没跟进的自动放进公海。业务配置里没开（poolDays = 0）就什么都不做；一天最多扫一次。
 * 客户页、首页加载时调，扫出来的当场就能在列表上看到。
 *
 * **团队模式下每台只扫自己名下的**：自己的跟进本机最全。扫别人的，可能同事刚写的跟进还没拉到，
 * 就把他正在谈的人扔进了公海。一个库多人（托管版、自部署）大家看的是同一份数据，扫全部。
 */
export async function 自动掉公海(me: { id: string; name: string }, 今: Date = new Date()): Promise<number> {
  const b = await getBusiness();
  if (!b.poolDays) return 0;
  const 今天 = dayjs(今).format("YYYY-MM-DD");
  if ((await getSetting<string>(扫过键)) === 今天) return 0;

  const 截止 = 公海截止(b.poolDays, 今);
  const 要掉 = await prisma.customer.findMany({
    where: {
      pool: null,
      followStatus: { notIn: [...不掉公海的状态] },
      ...(读团队() ? { salesOwnerId: me.id } : {}),
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
  await setSetting(扫过键, 今天);
  return 要掉.length;
}

/**
 * 客户页两个页签上的数（不带筛选）：「客户」= 不在公海的，「公海」= 在公海的。和左栏「客户」角标同一套限定，两数相加 = 角标。
 *
 * 不限定时（老板、没进团队、企业版看全公司的）不拿 `pool: { is / isNot: null }` 去数：Prisma 把它展开成
 * Customer LEFT JOIN CustomerPool 再套一层子查询，10 万客户一次 ~10 ms，每次进客户页要数两遍（2026-10-25 企业版 p95）。
 * 改成数公海表 + 全部客户相减：公海表的 customerId 是外键、删客户连带删，条数就是公海里的客户数。
 * 限定了（业务员）照旧两头数：客户查询会自动带上范围、公海表不带，相减就对不上了
 */
export async function 客户页签数(): Promise<{ 公海: number; 非公海: number }> {
  if (await 限定的我(defaultClient)) {
    const [公海, 非公海] = await Promise.all([
      prisma.customer.count({ where: { pool: { isNot: null } } }),
      prisma.customer.count({ where: { pool: { is: null } } }),
    ]);
    return { 公海, 非公海 };
  }
  const [全部, 公海] = await Promise.all([prisma.customer.count(), prisma.customerPool.count()]);
  return { 公海, 非公海: 全部 - 公海 };
}
