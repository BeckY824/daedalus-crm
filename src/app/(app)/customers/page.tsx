import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import CustomersView from "./CustomersView";
import { 负责人候选 } from "@/lib/owners";
import { 可选渠道, 可选客户 } from "@/lib/options";
import { 号码脱敏器 } from "@/lib/shared-ws/current";
import { llmEnabled } from "@/lib/llm";
import { 客户筛选条件, 客户行字段, 成客户行, 客户金额分页 } from "./query";
import { 规整币种 } from "@/lib/currency";
import { 自动掉公海 } from "@/lib/pool-db";
import { getBusiness } from "@/lib/business";

export const dynamic = "force-dynamic";

type SP = Promise<{
  keyword?: string;
  grade?: string;
  followStatus?: string;
  decisionStatus?: string;
  salesOwnerId?: string;
  channelOwnerId?: string;
  /** 外贸档案的国家 / 来源（2026-10-05） */
  country?: string;
  source?: string;
  page?: string;
  pageSize?: string;
  sort?: string;
  sortCurrency?: string;
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
  /** 「1」= 只看公海 */
  pool?: string;
}>;

export default async function CustomersPage({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  // 开了「N 天没跟进自动放进公海」的话，一天扫一次；扫出来的这一页就能看到
  await 自动掉公海(me);

  const 正整数 = (raw: string | undefined, fallback: number) => {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : fallback;
  };
  const pageSize = Math.min(100, Math.max(10, 正整数(sp.pageSize, 20)));
  const b = await getBusiness();
  const sort = sp.sort === "amount-asc" || sp.sort === "amount-desc" ? sp.sort : "";
  const sortCurrency = 规整币种(sp.sortCurrency, b.currency);

  const where = await 客户筛选条件(sp);
  // URL 参数、删空最后一页都不能使 skip 变成 NaN 或停留在空的越界页。
  const total = await prisma.customer.count({ where });
  const page = Math.min(正整数(sp.page, 1), Math.max(1, Math.ceil(total / pageSize)));

  const [rows, users, channels, allCustomers, 用着的职位, 用着的国家] = await Promise.all([
    sort ? 客户金额分页(where, sort, sortCurrency, page, pageSize) : prisma.customer.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: 客户行字段,
    }),
    负责人候选(),
    可选渠道(),
    可选客户(),
    prisma.customer.findMany({ where: { grade: { not: null } }, distinct: ["grade"], select: { grade: true } }),
    // 国家筛选只给库里真有的（外贸，2026-10-05）：一百多个国家摆一长串，挑到的多半是 0 条
    prisma.customerExtra.findMany({ where: { country: { not: null } }, distinct: ["country"], select: { country: true }, orderBy: { country: "asc" } }),
  ]);
  // 业务配置里删掉了、库里还有人在用的职位：筛选下拉照样给（第 2 期 2b「删选项后老记录照样能筛」）
  const 旧职位 = 用着的职位.map((c) => c.grade!.trim()).filter((g) => g && !b.grades.includes(g)).sort();
  const 号 = await 号码脱敏器();
  const aiEnabled = await llmEnabled();

  return (
    <CustomersView
      rows={rows.map((r) => 成客户行(r, 号))}
      total={total}
      page={page}
      pageSize={pageSize}
      金额排序={sort}
      排序币种={sortCurrency}
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
        pool: sp.pool === "1" ? "1" : "",
        country: sp.country ?? "",
        source: sp.source ?? "",
      }}
      本月新增={sp.createdWithin === "本月"}
      直接推荐={sp.directOf ? ((await prisma.channel.findUnique({ where: { id: sp.directOf }, select: { name: true } }))?.name ?? "这个渠道") : null}
      本批={sp.batch ? { 几位: total } : null}
      aiEnabled={aiEnabled}
      旧职位={[...new Set(旧职位)]}
      国家们={用着的国家.map((x) => x.country!).filter(Boolean)}
    />
  );
}
