import { prisma } from "./prisma";

/**
 * 推荐归属计算。
 *
 * 三个角色互相独立，不要混淆：
 *   推荐人   —— 谁直接把人介绍来的，逐级如实记录
 *   渠道归属 —— 推荐链往上第二代；不足两代则取链条最顶端
 *   渠道负责人 —— 链条最顶端那个外部渠道所属的内部员工，整条线永久继承
 *
 * 以「小红(渠道) → 小明 → 室友 → 朋友」为例：
 *
 *   学员    推荐人   渠道归属        渠道负责人
 *   小明    小红     小红(不足两代)   张三
 *   室友    小明     小红            张三
 *   朋友    室友     小明            张三
 */

export type AttributionInput = {
  /** 直接推荐人是已有学员时传其 id */
  referrerCustomerId?: string | null;
  /** 直接推荐人是外部渠道时传其 id */
  channelId?: string | null;
};

export type AttributionResult = {
  /** 链条最顶端的外部渠道 */
  channelId: string | null;
  /** 渠道归属落在外部渠道上 */
  attributionChannelId: string | null;
  /** 渠道归属落在已有学员上 */
  attributionCustomerId: string | null;
  /** 渠道负责人（内部员工） */
  channelOwnerId: string | null;
};

/**
 * 根据直接推荐人算出归属三件套。
 * 新建和修改推荐人时都要调用，结果固化到 Customer 上——
 * 这样后续改动上游不会追溯性地改变已有学员的归属与业绩。
 */
export async function resolveAttribution(
  input: AttributionInput,
): Promise<AttributionResult> {
  const empty: AttributionResult = {
    channelId: null,
    attributionChannelId: null,
    attributionCustomerId: null,
    channelOwnerId: null,
  };

  // 情况一：由外部渠道直接推荐（小明）
  // 上游只有渠道一层，不足两代，渠道归属取链条顶端即该渠道本身
  if (input.channelId) {
    const channel = await prisma.channel.findUnique({
      where: { id: input.channelId },
      select: { id: true, channelOwnerId: true },
    });
    if (!channel) return empty;
    return {
      channelId: channel.id,
      attributionChannelId: channel.id,
      attributionCustomerId: null,
      channelOwnerId: channel.channelOwnerId,
    };
  }

  // 情况二：由已有学员推荐（室友、朋友）
  if (input.referrerCustomerId) {
    const referrer = await prisma.customer.findUnique({
      where: { id: input.referrerCustomerId },
      select: {
        id: true,
        channelId: true,
        channelOwnerId: true,
        referrerCustomerId: true,
      },
    });
    if (!referrer) return empty;

    // 往上第二代 = 推荐人的推荐人
    if (referrer.referrerCustomerId) {
      // 推荐人本身也是被学员推荐来的 → 第二代是那位学员（朋友 → 小明）
      return {
        channelId: referrer.channelId,
        attributionChannelId: null,
        attributionCustomerId: referrer.referrerCustomerId,
        channelOwnerId: referrer.channelOwnerId,
      };
    }

    // 推荐人是渠道直接带来的 → 第二代就是那个渠道（室友 → 小红）
    return {
      channelId: referrer.channelId,
      attributionChannelId: referrer.channelId,
      attributionCustomerId: null,
      channelOwnerId: referrer.channelOwnerId,
    };
  }

  // 自然流量：无推荐人，渠道负责人留空由人工指定
  return empty;
}

/**
 * 渠道列表那三列：直接推荐 / 整条推荐链 / 链上签约额。
 *
 * **「直接」和「整条链」必须用两个谓词算。** 2026-09-19 之前这两列永远一模一样：
 * 「直接」取的是 Prisma 关系 `Channel.directCustomers` 的 `_count`，而那个关系走
 * `Customer.channelId`——按 schema 的定义它是**链条最顶端的渠道、所有后代继承**，
 * 数的本来就是整条链。关系名叫 direct，数的却是 chain，两列并排摆着、
 * 一列还写着「含下游转介绍」，却是同一个谓词算了两遍。
 * 转介绍到底带来了多少人，那张表一直答不出来。
 *
 * 真正的「直接」= channelId 命中**且没有上游学员**——见上面 resolveAttribution
 * 的情况一：渠道直荐时 referrerCustomerId 留空，被学员转介绍来的则一定有值。
 * 差额（chain - direct）就是转介绍带来的部分，那正是这张表想让人看见的东西。
 *
 * 抽成纯函数是为了钉得住：它是一处「两个数必须不同」的地方，
 * 写回同一个谓词不会报错，只会让一整列悄悄变成另一列的副本。
 */
export function 渠道汇总(
  渠道ids: string[],
  学员们: { channelId: string | null; referrerCustomerId: string | null; contracts: { amount: number }[] }[],
): Record<string, { id: string; directCustomers: number; chainCustomers: number; chainAmount: number }> {
  const out = Object.fromEntries(
    渠道ids.map((id) => [id, { id, directCustomers: 0, chainCustomers: 0, chainAmount: 0 }]),
  );
  for (const c of 学员们) {
    const 桶 = c.channelId ? out[c.channelId] : undefined;
    if (!桶) continue;
    桶.chainCustomers += 1;
    桶.chainAmount += c.contracts.reduce((s, ct) => s + ct.amount, 0);
    if (!c.referrerCustomerId) 桶.directCustomers += 1;
  }
  return out;
}

/** 归属对象的展示名，供列表与详情统一使用 */
export function attributionLabel(c: {
  attributionChannel?: { name: string } | null;
  attributionCustomer?: { name: string } | null;
}): string {
  return c.attributionChannel?.name ?? c.attributionCustomer?.name ?? "—";
}

/**
 * 改推荐人前检查是否会让推荐链成环。
 *
 * saveCustomer 原本只挡了「推荐人是自己」，但两步就能绕过：
 * 先把小明的推荐人设成室友，再把室友的推荐人设成小明。
 * 成环之后归属计算与详情页的上下游展示会自相矛盾，且全程没有报错。
 * 两个人各改一头、互不知情时尤其容易撞出来。
 *
 * 沿着新推荐人往上走，撞到自己即成环；顺带用 seen 兜住已经存在的环，
 * 避免这个函数自己陷入死循环。
 */
export async function wouldCreateCycle(
  customerId: string,
  newReferrerId: string,
): Promise<boolean> {
  if (customerId === newReferrerId) return true;
  const seen = new Set<string>([customerId]);
  let cur: string | null = newReferrerId;
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    const row: { referrerCustomerId: string | null } | null =
      await prisma.customer.findUnique({
        where: { id: cur },
        select: { referrerCustomerId: true },
      });
    cur = row?.referrerCustomerId ?? null;
  }
  return false;
}
