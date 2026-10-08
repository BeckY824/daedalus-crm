/**
 * 转介绍雷达 —— 把逐级如实记录的推荐链变成进攻工具。
 *
 * 两个问题，全部纯规则回答：
 *   1. 谁在帮我们带人（推荐榜）——按直接推荐的人数与其签约额排
 *   2. 下一个该请谁帮忙介绍（建议邀请）——有真实成交记录且尚无直接推荐记录的客户
 * AI 不参与筛选，只在销售点「起草邀请」时按需写话术。
 *
 * 口径：只算**直接推荐**这一层。整条链的归属业绩已经在渠道表里有了，
 * 雷达要回答的是"该找谁开口"，看直接关系就够，把链路全展开只会更难读。
 */
import { 合并合计, 合计文字, type 币种合计 } from "./currency";

export type RadarCustomer = {
  id: string;
  name: string;
  followStatus: string;
  referrerCustomerId: string | null;
  /** 真实成交记录数；旧调用方未给时，仅以已有金额判断。 */
  contractCount?: number;
  /** 兼容旧调用方的人民币金额；给了signed时不再用于排序。 */
  signedAmount: number;
  /** 本人签约按币种（2026-10-03）。不给就当 signedAmount 是人民币 */
  signed?: 币种合计[];
};

export type TopReferrer = {
  customerId: string;
  name: string;
  /** 直接推荐来的人数 */
  referralCount: number;
  /** 其中已签约的人数 */
  signedCount: number;
  /** 下游指定排序币种金额，不跨币种相加；显示用downstream。 */
  downstreamAmount: number;
  /** 同上，按币种分开（不换汇），显示用 */
  downstream: 币种合计[];
};

export type InviteCandidate = {
  customerId: string;
  name: string;
  reason: string;
};

const 按币 = (c: RadarCustomer): 币种合计[] => c.signed ?? (c.signedAmount ? [{ 币种: "CNY", 合计: c.signedAmount }] : []);

const 有成交 = (c: RadarCustomer) => c.contractCount !== undefined ? c.contractCount > 0 : 按币(c).some(row=>row.合计 > 0);
const 按排序币 = (rows:币种合计[],currency:string) => rows.find(row=>row.币种 === currency)?.合计 ?? 0;

export function buildReferralRadar(customers: RadarCustomer[], currency="CNY", dealLabel="签约"): {
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
      downstream: [],
    };
    cur.referralCount += 1;
    if (有成交(c)) cur.signedCount += 1;
    cur.downstream = 合并合计(cur.downstream, 按币(c));
    cur.downstreamAmount = 按排序币(cur.downstream,currency);
    stats.set(referrer.id, cur);
  }
  const topReferrers = [...stats.values()]
    .sort((a, b) => b.referralCount - a.referralCount || b.downstreamAmount - a.downstreamAmount || a.customerId.localeCompare(b.customerId))
    .slice(0, 5);

  // 只有真实成交记录才列候选；没有直接推荐记录不等于没有邀请过，不能编造邀请历史。
  const inviteCandidates = customers
    .filter((c) => 有成交(c) && !stats.has(c.id))
    .sort((a, b) => 按排序币(按币(b),currency)-按排序币(按币(a),currency) || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((c) => ({
      customerId: c.id,
      name: c.name,
      reason: `有${dealLabel}记录（${合计文字(按币(c))}），尚无直接推荐记录`,
    }));

  return { topReferrers, inviteCandidates };
}
