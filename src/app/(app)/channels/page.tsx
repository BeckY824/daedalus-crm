import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import ChannelsView from "./ChannelsView";
import { 负责人候选 } from "@/lib/owners";
import { llmEnabled } from "@/lib/llm";
import { buildReferralRadar } from "@/lib/referral";

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
  await requireUser();

  const [channels, users] = await Promise.all([
    prisma.channel.findMany({
      orderBy: [{ active: "desc" }, { createdAt: "desc" }],
      select: {
        id: true, name: true, phone: true, remark: true, active: true, createdAt: true,
        channelOwnerId: true,
        channelOwner: { select: { name: true } },
        _count: { select: { directCustomers: true } },
      },
    }),
    /*
      走 负责人候选()，不直接查「排除管理员」。
      「渠道负责人」是必填项，而桌面端和刚注册的托管版工作区里只有一个人、那个人是管理员——
      直接用严格口径的话这个下拉是空的，于是**新建渠道这条路整个走不通**（2026-09-18 报上来的）。
      候选名单里留了「没有别人时列出全部在职成员」那条回退，见 lib/owners.ts。
    */
    负责人候选(),
  ]);

  /**
   * 学员只查**一次**，渠道汇总和转介绍雷达都从这一份里算。
   *
   * 原来这里是 `channels.map(async ...)`：每个渠道各跑一次 `customer.findMany`，
   * 渠道有几个就往返几次；紧接着又几乎重复地全表查了一遍学员给雷达用，
   * 两处的差别只有一个 channelId 字段。渠道多起来之后，切到这一页要等的就是这些往返——
   * 2026-09-17 在桌面端真机上看到这一页会闪一段骨架屏，量的就是它。
   * 本地 CRM 的学员规模一次取回完全撑得住，按 channelId 在内存里分组即可。
   */
  const allCustomers = await prisma.customer.findMany({
    select: {
      id: true,
      name: true,
      followStatus: true,
      referrerCustomerId: true,
      channelId: true,
      contracts: { select: { amount: true } },
    },
  });

  const 签约额 = (c: { contracts: { amount: number }[] }) => c.contracts.reduce((s, ct) => s + ct.amount, 0);
  const statMap: Record<string, { id: string; chainCustomers: number; chainAmount: number }> = Object.fromEntries(
    channels.map((c) => [c.id, { id: c.id, chainCustomers: 0, chainAmount: 0 }]),
  );
  for (const cu of allCustomers) {
    const 桶 = cu.channelId ? statMap[cu.channelId] : undefined;
    if (!桶) continue;
    桶.chainCustomers += 1;
    桶.chainAmount += 签约额(cu);
  }

  const radar = buildReferralRadar(
    allCustomers.map((c) => ({
      id: c.id,
      name: c.name,
      followStatus: c.followStatus,
      referrerCustomerId: c.referrerCustomerId,
      signedAmount: 签约额(c),
    })),
  );

  return (
    <ChannelsView
      users={users}
      radar={radar}
      aiEnabled={await llmEnabled()}
      rows={channels.map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        remark: c.remark,
        active: c.active,
        createdAt: c.createdAt.toISOString(),
        channelOwnerId: c.channelOwnerId,
        channelOwnerName: c.channelOwner.name,
        directCount: c._count.directCustomers,
        chainCount: statMap[c.id]?.chainCustomers ?? 0,
        chainAmount: statMap[c.id]?.chainAmount ?? 0,
      }))}
    />
  );
}
