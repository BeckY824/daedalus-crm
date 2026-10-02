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

/**
 * 给还没记「签约那一刻是谁的」的老签约补上一行，按**此刻**客户的负责人（2026-10-02 排查 X1）。
 *
 * 0.46.15 之前登记的签约都没有 ContractOwner，报表对它们退回按客户「现在」的负责人算——
 * 于是升级后一停用张三、转给李四，张三的老业绩整笔搬到李四名下，而停用留痕写的是「历史业绩不动」。
 * 迁移里不许写 INSERT（tests/migrations.test.ts），所以在**任何换负责人的动作之前**调一次：
 * 那一刻的负责人就是升级以来一直的负责人，钉住它，之后怎么换都不追溯。没有缺的就什么都不写。
 */
export async function 钉住老签约(): Promise<number> {
  const 缺的 = await prisma.contract.findMany({
    where: { owner: { is: null } },
    select: { id: true, customer: { select: { salesOwnerId: true, channelOwnerId: true } } },
  });
  if (缺的.length === 0) return 0;
  const r = await prisma.contractOwner.createMany({
    data: 缺的.map((c) => ({ contractId: c.id, salesOwnerId: c.customer.salesOwnerId, channelOwnerId: c.customer.channelOwnerId })),
  });
  return r.count;
}
