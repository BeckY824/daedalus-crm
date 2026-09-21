import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import CustomersView from "./CustomersView";
import type { Prisma } from "@/generated/prisma";
import { 负责人候选 } from "@/lib/owners";
import { 号码脱敏器 } from "@/lib/shared-ws/current";
import { llmEnabled } from "@/lib/llm";
import { dayjs } from "@/lib/utils";

export const dynamic = "force-dynamic";

type SP = Promise<{
  keyword?: string;
  grade?: string;
  followStatus?: string;
  decisionStatus?: string;
  salesOwnerId?: string;
  channelOwnerId?: string;
  page?: string;
  pageSize?: string;
  /**
   * 「数据」页上那张「新增学员」卡点进来的。眼下只认「本月」一个值。
   *
   * 它不进筛选栏：筛选栏摆的是每天都在用的那几个，这一条是**从一个数走进它的明细**，
   * 用完就走。但它必须写在筛选提示里让人看见自己正在看一个子集——
   * 否则人会把一屏 24 条当成全部（见 CustomersView 里那条提示）。
   */
  createdWithin?: string;
  /** 从首页那张「开始」卡过来的：直接把新建表单打开，省一次点击 */
  new?: string;
  /**
   * `paste`：直接把导入抽屉开在「粘一段文本」那一栏。
   *
   * 主线是「粘一段聊天 → 客户本自己长出来」，而这条路原来要先点「导入」、
   * 再在抽屉里切到第二个栏位。首页那张「开始」卡、以后的菜单项和快捷键都指这个地址。
   */
  import?: string;
}>;

export default async function CustomersPage({ searchParams }: { searchParams: SP }) {
  await requireUser();
  const sp = await searchParams;

  const page = Math.max(1, Number(sp.page ?? 1));
  const pageSize = Math.min(100, Math.max(10, Number(sp.pageSize ?? 20)));

  const where: Prisma.CustomerWhereInput = {
    ...(sp.keyword
      ? {
          OR: [
            { name: { contains: sp.keyword } },
            { phone: { contains: sp.keyword } },
            { school: { contains: sp.keyword } },
            { major: { contains: sp.keyword } },
          ],
        }
      : {}),
    ...(sp.grade ? { grade: sp.grade } : {}),
    ...(sp.followStatus ? { followStatus: sp.followStatus } : {}),
    ...(sp.decisionStatus ? { decisionStatus: sp.decisionStatus } : {}),
    ...(sp.salesOwnerId ? { salesOwnerId: sp.salesOwnerId } : {}),
    ...(sp.channelOwnerId ? { channelOwnerId: sp.channelOwnerId } : {}),
    ...(sp.createdWithin === "本月" ? { createdAt: { gte: dayjs().startOf("month").toDate() } } : {}),
  };

  const [rows, total, users, channels, allCustomers] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, name: true, phone: true, school: true, grade: true, major: true,
        followStatus: true, decisionStatus: true, expectedSignAt: true, lastFollowAt: true,
        remark: true, referrerCustomerId: true, channelId: true, salesOwnerId: true, channelOwnerId: true,
        updatedAt: true,
        salesOwner: { select: { name: true } },
        channelOwner: { select: { name: true } },
        channel: { select: { name: true } },
        referrerCustomer: { select: { name: true } },
        attributionChannel: { select: { name: true } },
        attributionCustomer: { select: { name: true } },
        contracts: { select: { amount: true } },
      },
    }),
    prisma.customer.count({ where }),
    负责人候选(),
    prisma.channel.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.customer.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const 号 = await 号码脱敏器();
  const aiEnabled = await llmEnabled();

  return (
    <CustomersView
      rows={rows.map((r) => ({
        id: r.id,
        name: r.name,
        phone: 号(r.phone),
        school: r.school,
        grade: r.grade,
        major: r.major,
        followStatus: r.followStatus,
        decisionStatus: r.decisionStatus,
        expectedSignAt: r.expectedSignAt?.toISOString() ?? null,
        lastFollowAt: r.lastFollowAt?.toISOString() ?? null,
        remark: r.remark,
        referrerCustomerId: r.referrerCustomerId,
        channelId: r.channelId,
        // 推荐人可能是渠道，也可能是已有学员
        referrerName: r.referrerCustomer?.name ?? r.channel?.name ?? null,
        // 渠道归属：往上两代的计算结果
        attributionName: r.attributionChannel?.name ?? r.attributionCustomer?.name ?? null,
        channelOwnerId: r.channelOwnerId,
        channelOwnerName: r.channelOwner?.name ?? null,
        salesOwnerId: r.salesOwnerId,
        salesOwnerName: r.salesOwner.name,
        signedAmount: r.contracts.reduce((s, c) => s + c.amount, 0),
        // 并发闸门：编辑框拿它作为「我看到的是哪一版」
        updatedAt: r.updatedAt.toISOString(),
      }))}
      total={total}
      page={page}
      pageSize={pageSize}
      users={users}
      channels={channels}
      customers={allCustomers}
      直接新建={sp.new === "1"}
      /* ?import=paste：直接把导入抽屉开在「粘一段文本」那一栏（首页那张「开始」卡指过来） */
      直接粘贴={sp.import === "paste"}
      filters={{
        keyword: sp.keyword ?? "",
        grade: sp.grade ?? "",
        followStatus: sp.followStatus ?? "",
        decisionStatus: sp.decisionStatus ?? "",
        salesOwnerId: sp.salesOwnerId ?? "",
        channelOwnerId: sp.channelOwnerId ?? "",
      }}
      本月新增={sp.createdWithin === "本月"}
      aiEnabled={aiEnabled}
    />
  );
}
