/**
 * 编辑客户时「推荐人」那一栏初始选哪一档。
 *
 * **先看推荐人，再看渠道。** 转介绍来的人 channelId 也有值——那是推荐链最顶端、整条链继承的渠道
 * （lib/attribution.ts）。原来先看 channelId，转介绍的人一打开就被认成「外部渠道」，
 * 只改一下备注保存，推荐人就被清掉、归属按渠道直荐重算（2026-10-01 排查 A1）。
 */
export function 推荐方式(c: { channelId: string | null; referrerCustomerId: string | null } | null | undefined): "channel" | "customer" | "none" {
  if (c?.referrerCustomerId) return "customer";
  if (c?.channelId) return "channel";
  return "none";
}
