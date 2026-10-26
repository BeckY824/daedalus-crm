import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import CustomersView from "./CustomersView";
import { 负责人候选 } from "@/lib/owners";
import { 可选渠道 } from "@/lib/options";
import { 号码脱敏器 } from "@/lib/shared-ws/current";
import { llmEnabled } from "@/lib/llm";
import { 客户筛选条件, 客户行字段, 成客户行, 客户金额分页, 在看子集, 只按页签 } from "./query";
import { 规整币种 } from "@/lib/currency";
import { 自动掉公海, 客户页签数 } from "@/lib/pool-db";
import { getBusiness } from "@/lib/business";
import { 读的我, 虚线只读的 } from "@/lib/team-scope";
import { defaultClient } from "@/lib/prisma";
import { 读团队 } from "@/lib/sync/client";
import { 客户页签归属 } from "@/lib/pool";
import { 管全队客户 } from "@/lib/constants";
import { 摊平部门 } from "@/lib/sync/dept-policy";
import { 拦原负责人 } from "@/lib/enterprise/pool-rules";

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
  /** 客户等级（2026-10-16）：A–D 或「未分级」 */
  level?: string;
  /** 团队版部门（1b，2026-10-23）：负责人在这个部门连下级里的 */
  dept?: string;
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
  /** 「1」= 「公海」页签；不给 = 「客户」页签，不含公海里的（子集入口例外，见 query.ts 在看子集） */
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
  // 首页「开始」卡的 ?new=1：项目模式开着时新建走建档向导
  if (b.projectMode && sp.new === "1") redirect("/projects/new");
  const sort = sp.sort === "amount-asc" || sp.sort === "amount-desc" ? sp.sort : "";
  /** 按客户等级排（2026-10-16）：A→D 或 D→A，没分级的总在最后 */
  const 等级排序 = sp.sort === "level-asc" || sp.sort === "level-desc" ? sp.sort : "";
  const sortCurrency = 规整币种(sp.sortCurrency, b.currency);

  const where = await 客户筛选条件(sp);
  // URL 参数、删空最后一页都不能使 skip 变成 NaN 或停留在空的越界页。
  const 子集 = 在看子集(sp);
  /*
    两个页签上的数：都不带筛选、和左栏「客户」角标在同一套限定下数（layout.tsx 的 customer.count()），
    所以「我的 / 团队客户 N」+「公海 M」= 角标。子集里不摆页签，不数
  */
  const 就是页签 = 子集 ? null : 只按页签(where);
  const [筛出, 页签数] = await Promise.all([
    就是页签 ? Promise.resolve(null) : prisma.customer.count({ where }),
    子集 ? Promise.resolve(null) : 客户页签数(),
  ]);
  const 公海总数 = 页签数?.公海 ?? null;
  const 非公海总数 = 页签数?.非公海 ?? null;
  // 除了页签什么都没筛（最常见的「点进客户页」）：总数就是页签上那个数，不再数一遍
  const total = 筛出 ?? (就是页签 === "公海" ? 公海总数 : 非公海总数) ?? 0;
  /*
    「客户」页签搜不到、公海里却有对得上的：数出来给一条去公海页签的路（领导点「搜一下」找不到人，多半是掉进公海了）。
    负责人条件不带：换到公海页签时它会清掉（公海里的负责人是「原负责人」），数要和点过去看到的对得上
  */
  const 公海里匹配 = !子集 && sp.pool !== "1" && total === 0 && 公海总数
    ? await prisma.customer.count({ where: await 客户筛选条件({ ...sp, pool: "1", salesOwnerId: undefined }) })
    : 0;
  const page = Math.min(正整数(sp.page, 1), Math.max(1, Math.ceil(total / pageSize)));

  const [rows, users, channels, 用着的职位, 用着的国家] = await Promise.all([
    sort ? 客户金额分页(where, sort, sortCurrency, page, pageSize) : prisma.customer.findMany({
      where,
      orderBy: 等级排序
        ? [{ extra: { level: { sort: 等级排序 === "level-asc" ? "asc" : "desc", nulls: "last" } } }, { createdAt: "desc" }, { id: "desc" }]
        : [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: 客户行字段,
    }),
    负责人候选(),
    可选渠道(),
    // 下拉只要去重后的值：用 groupBy 在库里去重。Prisma 的 distinct 是整列拉回来在 JS 里去重，10 倍数据一次 50–60 ms（2026-10-25）
    prisma.customer.groupBy({ by: ["grade"], where: { grade: { not: null } } }),
    // 国家筛选只给库里真有的（外贸，2026-10-05）：一百多个国家摆一长串，挑到的多半是 0 条
    prisma.customerExtra.groupBy({ by: ["country"], where: { country: { not: null } }, orderBy: { country: "asc" } }),
  ]);
  // 业务配置里删掉了、库里还有人在用的职位：筛选下拉照样给（第 2 期 2b「删选项后老记录照样能筛」）
  const 旧职位 = 用着的职位.map((c) => c.grade!.trim()).filter((g) => g && !b.grades.includes(g)).sort();
  // 团队有两个以上一级部门才摆「全部部门」（10-23：总管理默认看全公司，列表加部门筛选）；只有一个时等于没分部门
  const 编制 = 读团队()?.编制;
  const 部门选项 = 编制 && new Set(编制.部门.map((d) => d.top).filter(Boolean)).size >= 2
    ? 摊平部门(编制.部门).map(({ d, 层 }) => ({ value: d.id, label: `${"　".repeat(层 - 1)}${d.name}` }))
    : [];
  const 号 = await 号码脱敏器();
  const aiEnabled = await llmEnabled();

  return (
    <CustomersView
      // 公海里的直接分给同事：只给管理员（团队版的老板）。业务员那边不摆（2026-10-20）
      能分配公海={管全队客户(me.role)}
      rows={rows.map((r) => 成客户行(r, 号))}
      total={total}
      page={page}
      requestedPage={sp.page}
      pageSize={pageSize}
      金额排序={sort}
      等级排序={等级排序}
      排序币种={sortCurrency}
      users={users}
      channels={channels}
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
        level: sp.level ?? "",
        dept: sp.dept ?? "",
      }}
      部门选项={部门选项}
      // 企业版虚线下属的客户：只能看（10-25 实测 F4）。团队版、没开组织架构可见范围时一律空
      只读ids={await 虚线只读的(defaultClient, rows.map((r) => r.id))}
      // 企业版「非原负责人均可领取」（10-26 定稿）：这一页公海里原负责人是我的，领取按钮灰着（接口也拦，pool-actions.ts 领取）
      原负责人领不回ids={拦原负责人() ? rows.filter((r) => r.pool && r.salesOwnerId === me.id).map((r) => r.id) : []}
      本月新增={sp.createdWithin === "本月"}
      直接推荐={sp.directOf ? ((await prisma.channel.findUnique({ where: { id: sp.directOf }, select: { name: true } }))?.name ?? "这个渠道") : null}
      本批={sp.batch ? { 几位: total } : null}
      公海数={公海总数}
      客户数={非公海总数}
      /*
        第一个页签叫「我的 / 团队客户」：和数据限定同一个来源——读的我() 有值 = 团队业务员、团队没开互看（lib/team-scope.ts，
        按中转名单对出来的本机角色；开了互看列表就是全队的，叫「团队」），读团队() 有 = 进了团队（.team.json）。都是缓存 / 读文件，不多查库
      */
      客户页签={客户页签归属({ 业务员: !!(await 读的我(defaultClient)), 在团队: !!读团队() })}
      公海里匹配={公海里匹配}
      aiEnabled={aiEnabled}
      旧职位={[...new Set(旧职位)]}
      国家们={用着的国家.map((x) => x.country!).filter(Boolean)}
    />
  );
}
