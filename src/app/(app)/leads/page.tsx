import { 号码脱敏器 } from "@/lib/shared-ws/current";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { 搜索词 } from "@/lib/search-keyword";
import LeadsView from "./LeadsView";
import type { Prisma } from "@/generated/prisma";
import { 负责人候选 } from "@/lib/owners";

export const dynamic = "force-dynamic";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ keyword?: string; status?: string }>;
}) {
  const me = await requireUser();
  const sp = await searchParams;
  // 关键词去掉前后空格再搜（2026-10-04 J-008）：复制来的「张三 」原来一个都搜不到
  const 词 = 搜索词(sp.keyword);

  const where: Prisma.LeadWhereInput = {
    ...(词
      ? { OR: [{ name: { contains: 词 } }, { contact: { contains: 词 } }] }
      : {}),
    ...(sp.status ? { status: sp.status } : {}),
  };

  const [总数, rows, users] = await Promise.all([
    /*
      **总数要单独数一次。** 下面那条 `take: 300` 取回来的行数不是总数，
      而 DataList 的分页条会照着行数写「共 N 条」——库里 500 条线索的人
      看到的是「共 300 条」，一个错的总数（2026-09-19 报上来的）。
      count 走的是同一个 where，和列表是同一个口径。
    */
    prisma.lead.count({ where }),
    prisma.lead.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 300,
      include: { owner: { select: { name: true } } },
    }),
    负责人候选(),
  ]);
  /**
   * 新建线索默认归「我」（LeadsView 里 ownerId: me）。我不在候选名单里时——桌面端单人用，
   * 你就是管理员，灌了演示数据之后名单里只剩那四个销售——下拉会显示成一串 id
   * （2026-09-17 在真机上看到的就是 `cmu58lup…`），编辑一条归管理员的线索也是同样的显示。
   * 服务端本来就收管理员当负责人，所以把我补进名单只是让它显示成名字。
   * 这一页原来直接查 可担任负责人 而不是走 负责人候选()，连单人工作区那条回退都没有。
   */
  const 候选 = users.some((u) => u.id === me.id) ? users : [...users, { id: me.id, name: me.name, email: me.email }];

  const 号 = await 号码脱敏器();
  return (
    <LeadsView
      总数={总数}
      me={me.id}
      users={候选}
      filters={{ keyword: sp.keyword ?? "", status: sp.status ?? "" }}
      rows={rows.map((l) => ({
        id: l.id,
        name: l.name,
        contact: l.contact,
        // 共享试用区打码，和客户、联系人同一个出口（2026-10-02 排查 A6）
        phone: 号(l.phone),
        email: l.email,
        industry: l.industry,
        source: l.source,
        status: l.status,
        remark: l.remark,
        ownerId: l.ownerId,
        ownerName: l.owner?.name ?? "—",
        customerId: l.customerId,
        createdAt: l.createdAt.toISOString(),
        updatedAt: l.updatedAt.toISOString(),
      }))}
    />
  );
}
