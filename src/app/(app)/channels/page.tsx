import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import ChannelsView from "./ChannelsView";
import { 可担任负责人 } from "@/lib/constants";
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
    prisma.user.findMany({ where: 可担任负责人, select: { id: true, name: true, email: true }, orderBy: { name: "asc" } }),
  ]);

  // 整条推荐链上的学员数与签约额，按渠道汇总
  const chainStats = await Promise.all(
    channels.map(async (c) => {
      const customers = await prisma.customer.findMany({
        where: { channelId: c.id },
        select: { contracts: { select: { amount: true } } },
      });
      return {
        id: c.id,
        chainCustomers: customers.length,
        chainAmount: customers.reduce((s, cu) => s + cu.contracts.reduce((a, ct) => a + ct.amount, 0), 0),
      };
    }),
  );
  const statMap = Object.fromEntries(chainStats.map((s) => [s.id, s]));

  // 转介绍雷达：学员之间的直接推荐关系（纯规则，见 src/lib/referral.ts）
  const radarCustomers = await prisma.customer.findMany({
    select: {
      id: true,
      name: true,
      followStatus: true,
      referrerCustomerId: true,
      contracts: { select: { amount: true } },
    },
  });
  const radar = buildReferralRadar(
    radarCustomers.map((c) => ({
      id: c.id,
      name: c.name,
      followStatus: c.followStatus,
      referrerCustomerId: c.referrerCustomerId,
      signedAmount: c.contracts.reduce((s, ct) => s + ct.amount, 0),
    })),
  );

  return (
    <ChannelsView
      users={users}
      radar={radar}
      aiEnabled={llmEnabled()}
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
