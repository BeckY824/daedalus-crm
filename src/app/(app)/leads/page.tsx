import { 号码脱敏器, 当前是共享区 } from "@/lib/shared-ws/current";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { 线索关键词条件 } from "@/lib/search-keyword";
import { getBusiness } from "@/lib/business";
import LeadsView from "./LeadsView";
import type { Prisma } from "@/generated/prisma";
import { 负责人候选 } from "@/lib/owners";
import { 规则开着 } from "@/lib/enterprise/rules";
import { 读组织 } from "@/lib/enterprise/org";
import { 能分配 } from "@/lib/enterprise/lead-assign";
import { 企业版 } from "@/lib/enterprise/switch";
import { 读满额提醒 } from "@/lib/enterprise/lead-full-notice";
import { 生效组织规则 } from "@/lib/project/org-rules-store";

export const dynamic = "force-dynamic";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ keyword?: string; status?: string; ownerId?: string; source?: string }>;
}) {
  const me = await requireUser();
  const sp = await searchParams;
  const where: Prisma.LeadWhereInput = {
    AND: [await 线索关键词条件(sp.keyword)],
    ...(sp.status ? { status: sp.status } : {}),
    ...(sp.ownerId ? { ownerId: sp.ownerId } : {}),
    ...(sp.source ? { source: sp.source } : {}),
  };

  const [总数, rows, users, 用着的来源, b] = await Promise.all([
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
    // 来源能选也能填：筛选下拉要把库里用着、设置里没有的也给出来（和客户列表的「旧职位」一个做法）
    prisma.lead.findMany({ distinct: ["source"], select: { source: true } }),
    getBusiness(),
  ]);
  const 来源们 = [...new Set([...b.sources, ...用着的来源.map((l) => l.source).filter(Boolean)])];
  /**
   * 新建线索默认归「我」（LeadsView 里 ownerId: me）。我不在候选名单里时——桌面端单人用，
   * 你就是管理员，灌了演示数据之后名单里只剩那四个销售——下拉会显示成一串 id
   * （2026-09-17 在真机上看到的就是 `cmu58lup…`），编辑一条归管理员的线索也是同样的显示。
   * 服务端本来就收管理员当负责人，所以把我补进名单只是让它显示成名字。
   * 这一页原来直接查 可担任负责人 而不是走 负责人候选()，连单人工作区那条回退都没有。
   */
  const 候选 = users.some((u) => u.id === me.id) ? users : [...users, { id: me.id, name: me.name, email: me.email }];

  const 号 = await 号码脱敏器();
  // 企业版「线索分配和配额」开着、我能分配（老板、总管理员、市场管理）才摆「分配」「自动分配」；服务端还会再查一遍
  const 线索分配开着 = (await 规则开着("线索分配")) && !(await 当前是共享区());
  const 能自动分配 = 线索分配开着 && 能分配(await 读组织(), me);
  // 企业版自动分配因都已满额没分出去的提醒（只发给市场管理、总管理员，见 lib/enterprise/lead-full-notice.ts）
  const 满额提醒们 = 企业版() ? await 读满额提醒(me.id) : [];
  // 企业版转项目要记首条跟进；开了超时回收，下一步时间必填（验收 #13，服务端 转项目前查 也拦）
  const 企业版项目 = 企业版() && b.projectMode === true;
  const 要下一步 = 企业版项目 && (await 生效组织规则()).超时回收.开;
  return (
    <LeadsView
      总数={总数}
      me={me.id}
      users={候选}
      filters={{ keyword: sp.keyword ?? "", status: sp.status ?? "", ownerId: sp.ownerId ?? "", source: sp.source ?? "" }}
      来源们={来源们}
      能自动分配={能自动分配}
      企业版项目={企业版项目}
      要下一步={要下一步}
      线索分配开着={线索分配开着}
      满额提醒={满额提醒们}
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
