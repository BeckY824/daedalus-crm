import { prisma } from "./prisma";

/**
 * 一笔签约算在谁头上（2026-10-02 排查 B2）。数据页的业绩、AI 的「按销售看签约」共用这一份。
 *
 * 算在**签约那一刻**的负责人头上（ContractOwner）。原来按客户「现在」的负责人算：
 * 换了负责人、停用了同事，他过去的签约整笔搬到接手的人头上，去年的业绩榜上这人就没了——
 * 和 09 月拍板「谁的数据没动，谁的归属就不变」矛盾。
 * 老签约没有那一行，退回按客户现在的负责人：更早的变动补不回来。
 */
type 人 = { id: string; name: string; email: string };
type 签约行 = {
  owner: { salesOwnerId: string | null; channelOwnerId: string | null } | null;
  customer: { salesOwner?: 人 | null; channelOwner?: 人 | null };
};

export async function 签约归属人<T extends 签约行>(rows: T[]) {
  const ids = new Set(rows.flatMap((c) => [c.owner?.salesOwnerId, c.owner?.channelOwnerId]).filter((x): x is string => Boolean(x)));
  const 当时的人 = new Map(
    (await prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u]),
  );
  const 找 = (id: string | null): 人 | null => (id ? 当时的人.get(id) ?? { id, name: "（已删除的成员）", email: "" } : null);
  return {
    销售: (c: T): 人 | null => (c.owner ? 找(c.owner.salesOwnerId) : c.customer.salesOwner ?? null),
    渠道负责人: (c: T): 人 | null => (c.owner ? 找(c.owner.channelOwnerId) : c.customer.channelOwner ?? null),
  };
}
