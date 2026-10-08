/**
 * 转介绍雷达规则。
 *
 * 两条命门：推荐榜的数字必须与推荐关系严格对上（这是要当着销售念的成绩单），
 * 建议邀请不能骚扰已经推荐过的人（请人帮忙的前提是记得人家帮过忙）。
 */
import { describe, it, expect } from "vitest";
import { buildReferralRadar, type RadarCustomer } from "@/lib/referral";

function c(over: Partial<RadarCustomer> & { id: string }): RadarCustomer {
  return { name: over.id, followStatus: "跟进中", referrerCustomerId: null, signedAmount: 0, ...over };
}

describe("推荐榜", () => {
  it("按直接推荐计数，统计下游签约人数与金额", () => {
    const { topReferrers } = buildReferralRadar([
      c({ id: "a", name: "老张", followStatus: "已签约", signedAmount: 10000 }),
      c({ id: "b", referrerCustomerId: "a", followStatus: "已签约", signedAmount: 8000 }),
      c({ id: "d", referrerCustomerId: "a", followStatus: "跟进中" }),
      // c 是 b 推荐的：属于 b 的战绩，不能算到链条顶端的 a 头上
      c({ id: "e", referrerCustomerId: "b", followStatus: "已签约", signedAmount: 5000 }),
    ]);
    expect(topReferrers[0]).toMatchObject({ name: "老张", referralCount: 2, signedCount: 1, downstreamAmount: 8000 });
    expect(topReferrers[1]).toMatchObject({ customerId: "b", referralCount: 1, downstreamAmount: 5000 });
  });

  it("推荐人已不在库里时整条丢弃，不显示孤儿数据", () => {
    const { topReferrers } = buildReferralRadar([c({ id: "b", referrerCustomerId: "ghost" })]);
    expect(topReferrers).toHaveLength(0);
  });

  it("同为 2 人时带来签约额高的排前面", () => {
    const { topReferrers } = buildReferralRadar([
      c({ id: "a" }),
      c({ id: "b" }),
      c({ id: "a1", referrerCustomerId: "a", signedAmount: 100 }),
      c({ id: "a2", referrerCustomerId: "a" }),
      c({ id: "b1", referrerCustomerId: "b", signedAmount: 9000, followStatus: "已签约" }),
      c({ id: "b2", referrerCustomerId: "b" }),
    ]);
    expect(topReferrers[0].customerId).toBe("b");
  });
});

describe("建议邀请", () => {
  it("只邀请已签约且还没推荐过人的学员，按签约额倒序", () => {
    const { inviteCandidates } = buildReferralRadar([
      c({ id: "signed-quiet", followStatus: "已签约", signedAmount: 9800 }),
      c({ id: "signed-big", followStatus: "已签约", signedAmount: 20000 }),
      // 已经推荐过人的不再提醒——请人帮忙的前提是记得人家帮过忙
      c({ id: "signed-referrer", followStatus: "已签约", signedAmount: 30000 }),
      c({ id: "x", referrerCustomerId: "signed-referrer" }),
      // 没签约的不邀请——还没用钱投票，开口要介绍为时过早
      c({ id: "not-signed", followStatus: "意向较高" }),
    ]);
    expect(inviteCandidates.map((x) => x.customerId)).toEqual(["signed-big", "signed-quiet"]);
    expect(inviteCandidates[0].reason).toContain("20,000");
  });
});

it("成交口径取真实记录而非可改状态，零金额合同仍是记录，不编造邀请历史",()=>{
 const result=buildReferralRadar([
 c({id:"referrer"}),c({id:"status-only",followStatus:"已签约",contractCount:0,referrerCustomerId:"referrer"}),
 c({id:"real-contract",followStatus:"已流失",contractCount:1,signedAmount:120,referrerCustomerId:"referrer"}),
 c({id:"zero-contract",followStatus:"跟进中",contractCount:1}),
 c({id:"not-real",followStatus:"已签约",contractCount:0}),
 ]);
 expect(result.topReferrers[0]).toMatchObject({signedCount:1,downstreamAmount:120});
 expect(result.inviteCandidates.map(row=>row.customerId)).toContain("zero-contract");expect(result.inviteCandidates.map(row=>row.customerId)).not.toContain("not-real");
 expect(result.inviteCandidates.every(row=>row.reason.includes("尚无直接推荐记录")&&!row.reason.includes("没请"))).toBe(true);
});
it("排序仅比较指定币种，美元和人民币不混加，外贸文案使用订单",()=>{
 const rows=[c({id:"usd",contractCount:1,signedAmount:10000,signed:[{币种:"USD",合计:10000}]}),c({id:"cny",contractCount:1,signedAmount:200,signed:[{币种:"CNY",合计:200}]}),c({id:"both",contractCount:1,signedAmount:10100,signed:[{币种:"CNY",合计:100},{币种:"USD",合计:10000}]})];
 expect(buildReferralRadar(rows,"CNY").inviteCandidates.map(row=>row.customerId)).toEqual(["cny","both","usd"]);
 const trade=buildReferralRadar(rows,"USD","订单");expect(trade.inviteCandidates.map(row=>row.customerId)).toEqual(["both","usd","cny"]);expect(trade.inviteCandidates[0].reason).toContain("订单记录");expect(trade.inviteCandidates[0].reason).toContain("US$ 10,000");
});
