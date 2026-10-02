import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import CustomersView from "./CustomersView";
import { 负责人候选 } from "@/lib/owners";
import { 可选渠道, 可选客户 } from "@/lib/options";
import { 号码脱敏器 } from "@/lib/shared-ws/current";
import { llmEnabled } from "@/lib/llm";
import { 客户筛选条件, 客户行字段, 成客户行 } from "./query";

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
  /** 只看这个渠道直接带来的（渠道页「直接推荐 N 人」点进来）。口径同 lib/attribution.ts 渠道汇总 */
  directOf?: string;
  /** 从首页那张「开始」卡过来的：直接把新建表单打开，省一次点击 */
  new?: string;
  /**
   * `paste`：直接把导入抽屉开在「粘一段文本」那一栏。
   *
   * 主线是「粘一段聊天 → 客户本自己长出来」，而这条路原来要先点「导入」、
   * 再在抽屉里切到第二个栏位。首页那张「开始」卡、以后的菜单项和快捷键都指这个地址。
   */
  import?: string;
  /** 导入抽屉点「完成」过来的：只看这一批导入建的 / 补过的那几位（审查 D10） */
  batch?: string;
}>;

export default async function CustomersPage({ searchParams }: { searchParams: SP }) {
  await requireUser();
  const sp = await searchParams;

  const page = Math.max(1, Number(sp.page ?? 1));
  const pageSize = Math.min(100, Math.max(10, Number(sp.pageSize ?? 20)));

  const where = await 客户筛选条件(sp);

  const [rows, total, users, channels, allCustomers] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: 客户行字段,
    }),
    prisma.customer.count({ where }),
    负责人候选(),
    可选渠道(),
    可选客户(),
  ]);
  const 号 = await 号码脱敏器();
  const aiEnabled = await llmEnabled();

  return (
    <CustomersView
      rows={rows.map((r) => 成客户行(r, 号))}
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
        createdWithin: sp.createdWithin ?? "",
        directOf: sp.directOf ?? "",
        batch: sp.batch ?? "",
      }}
      本月新增={sp.createdWithin === "本月"}
      直接推荐={sp.directOf ? ((await prisma.channel.findUnique({ where: { id: sp.directOf }, select: { name: true } }))?.name ?? "这个渠道") : null}
      本批={sp.batch ? { 几位: total } : null}
      aiEnabled={aiEnabled}
    />
  );
}
