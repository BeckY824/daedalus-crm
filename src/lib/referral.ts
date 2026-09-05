/**
 * 转介绍雷达 —— 把逐级如实记录的推荐链变成进攻工具。
 *
 * 两个问题，全部纯规则回答：
 *   1. 谁在帮我们带人（推荐榜）——按直接推荐的人数与其签约额排
 *   2. 下一个该请谁帮忙介绍（建议邀请）——已签约（用钱投过票）却还
 *      没被请求过转介绍的学员
 * AI 不参与筛选，只在销售点「起草邀请」时按需写话术。
 *
 * 口径：只算**直接推荐**这一层。整条链的归属业绩已经在渠道表里有了，
 * 雷达要回答的是"该找谁开口"，看直接关系就够，把链路全展开只会更难读。
 */

export type RadarCustomer = {
  id: string;
  name: string;
  followStatus: string;
  referrerCustomerId: string | null;
  /** 本人签约总额（元） */
  signedAmount: number;
};

export type TopReferrer = {
  customerId: string;
  name: string;
  /** 直接推荐来的人数 */
  referralCount: number;
  /** 其中已签约的人数 */
  signedCount: number;
  /** 直接推荐的学员签约总额 */
  downstreamAmount: number;
};

export type InviteCandidate = {
  customerId: string;
  name: string;
  reason: string;
};

export function buildReferralRadar(customers: RadarCustomer[]): {
  topReferrers: TopReferrer[];
  inviteCandidates: InviteCandidate[];
} {
  const byId = new Map(customers.map((c) => [c.id, c]));
  const stats = new Map<string, TopReferrer>();
  for (const c of customers) {
    if (!c.referrerCustomerId) continue;
    const referrer = byId.get(c.referrerCustomerId);
    if (!referrer) continue; // 推荐人已被删除等情况，宁可少一行也不显示孤儿 id
    const cur = stats.get(referrer.id) ?? {
      customerId: referrer.id,
      name: referrer.name,
      referralCount: 0,
      signedCount: 0,
      downstreamAmount: 0,
    };
    cur.referralCount += 1;
    if (c.followStatus === "已签约") cur.signedCount += 1;
    cur.downstreamAmount += c.signedAmount;
    stats.set(referrer.id, cur);
  }
  const topReferrers = [...stats.values()]
    .sort((a, b) => b.referralCount - a.referralCount || b.downstreamAmount - a.downstreamAmount)
    .slice(0, 5);

  // 已签约 = 用钱投过票，是最可能愿意介绍的人；已经推荐过的不用再提醒
  const inviteCandidates = customers
    .filter((c) => c.followStatus === "已签约" && !stats.has(c.id))
    .sort((a, b) => b.signedAmount - a.signedAmount)
    .slice(0, 5)
    .map((c) => ({
      customerId: c.id,
      name: c.name,
      reason: `已签约 ¥${Math.round(c.signedAmount).toLocaleString("zh-CN")}，还没请 TA 转介绍过`,
    }));

  return { topReferrers, inviteCandidates };
}
