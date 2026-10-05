import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { dayjs } from "@/lib/utils";
import { 带币种, 签约金额, 签约合计 } from "@/lib/money-db";
import { 搜索词, 号码片段, 有通配符, 字面包含的id } from "@/lib/search-keyword";
import { 取档案 } from "@/lib/customer-extra-db";

/**
 * 客户列表的查询条件、取哪些字段、怎么变成一行——列表页和「导出」共用这一份（2026-10-02 排查）。
 * 原来导出拿的是当前这一页的 rows（默认 20 条），文件名却像整张表；拆出来以后导出按同样的条件取全部。
 */

export type 客户条件 = {
  keyword?: string;
  grade?: string;
  followStatus?: string;
  decisionStatus?: string;
  salesOwnerId?: string;
  channelOwnerId?: string;
  createdWithin?: string;
  directOf?: string;
  batch?: string;
  /** 「1」= 只看公海里的（第 6 块） */
  pool?: string;
  /** 外贸档案的国家 / 来源（2026-10-05） */
  country?: string;
  source?: string;
};

/** 关键词搜的列，和下面 OR 里的一致（字面包含那条路也照这个搜） */
const 搜索列 = ["name", "phone", "school", "major", "grade", "remark"] as const;

export async function 客户筛选条件(
  sp: 客户条件,
): Promise<Prisma.CustomerWhereInput> {
  // 这一批导入动过的人。撤销过的批次不算（那些人已经删了 / 还原了）
  const 本批 = sp.batch
    ? await prisma.importRow.findMany({
        where: { batchId: sp.batch, batch: { revertedAt: null } },
        select: { customerId: true },
      })
    : null;

  /*
    关键词先 trim、号码按数字搜、% _ 当普通字符（2026-10-04 J-008），规则见 lib/search-keyword.ts。
    带 % _ 的走原生 SQL 先找出 id，放进 AND 里——和上面「这一批」的 id 条件并存，不能互相盖掉
  */
  const 词 = 搜索词(sp.keyword);
  const 号段 = 号码片段(词);
  const 字面 = 词 && 有通配符(词) ? await 字面包含的id("Customer", 搜索列, 词) : null;

  return {
    ...(本批 ? { id: { in: 本批.map((r) => r.customerId) } } : {}),
    ...(字面 ? { AND: [{ id: { in: 字面 } }] } : {}),
    ...(词 && !字面
      ? {
          OR: [
            { name: { contains: 词 } },
            { phone: { contains: 号段 ?? 词 } },
            { school: { contains: 词 } },
            { major: { contains: 词 } },
            // 年级、备注也搜，和 AI 的 search_customers 一个范围（排查 C7）：AI 说「大三的有 12 位」，点「去库里搜」不能是 0 条
            { grade: { contains: 词 } },
            { remark: { contains: 词 } },
            /*
              外贸档案和联系人也搜（2026-10-05 外贸客户：「联系人可以直接合并到客户里面」）。外贸模版左栏不摆联系人页，
              按联系人的名字、电话、邮箱、微信找到的就是他所在的那位客户
            */
            // 号码按原词也搜一遍（复查）：WhatsApp、联系人电话是原样存的（「+86 138 0000 1111」），只按纯数字号段搜会漏
            { extra: { is: { OR: [{ whatsapp: { contains: 词 } }, ...(号段 ? [{ whatsapp: { contains: 号段 } }] : []), { email: { contains: 词 } }, { wechat: { contains: 词 } }, { country: { contains: 词 } }] } } },
            { contacts: { some: { OR: [{ name: { contains: 词 } }, { phone: { contains: 词 } }, ...(号段 ? [{ phone: { contains: 号段 } }] : []), { email: { contains: 词 } }, { wechat: { contains: 词 } }] } } },
          ],
        }
      : {}),
    ...(sp.grade ? { grade: sp.grade } : {}),
    ...(sp.followStatus ? { followStatus: sp.followStatus } : {}),
    ...(sp.decisionStatus ? { decisionStatus: sp.decisionStatus } : {}),
    ...(sp.salesOwnerId ? { salesOwnerId: sp.salesOwnerId } : {}),
    ...(sp.channelOwnerId ? { channelOwnerId: sp.channelOwnerId } : {}),
    ...(sp.createdWithin === "本月"
      ? { createdAt: { gte: dayjs().startOf("month").toDate() } }
      : {}),
    /*
    渠道页「直接推荐 5 人」点进来：渠道对得上、且没有上游学员，和 渠道汇总() 的 directCustomers 一个口径。
    原来链接用 keyword=渠道名，而关键词不搜渠道，点进去基本是 0 条（2026-10-01 排查 C1）
  */
    ...(sp.directOf
      ? { channelId: sp.directOf, referrerCustomerId: null }
      : {}),
    ...(sp.pool === "1" ? { pool: { isNot: null } } : {}),
    ...(sp.country || sp.source
      ? { extra: { is: { ...(sp.country ? { country: sp.country } : {}), ...(sp.source ? { source: sp.source } : {}) } } }
      : {}),
  };
}

export const 客户行字段 = {
  id: true,
  name: true,
  phone: true,
  school: true,
  grade: true,
  major: true,
  followStatus: true,
  decisionStatus: true,
  expectedSignAt: true,
  lastFollowAt: true,
  remark: true,
  referrerCustomerId: true,
  channelId: true,
  salesOwnerId: true,
  channelOwnerId: true,
  updatedAt: true,
  salesOwner: { select: { name: true } },
  channelOwner: { select: { name: true } },
  channel: { select: { name: true } },
  referrerCustomer: { select: { name: true } },
  attributionChannel: { select: { name: true } },
  attributionCustomer: { select: { name: true } },
  contracts: { select: { amount: true, ...带币种.签约 } },
  pool: { select: { reason: true } },
  extra: true,
} satisfies Prisma.CustomerSelect;

type 取到的行 = Prisma.CustomerGetPayload<{ select: typeof 客户行字段 }>;

export function 成客户行(r: 取到的行, 号: (p: string) => string) {
  return {
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
    attributionName:
      r.attributionChannel?.name ?? r.attributionCustomer?.name ?? null,
    channelOwnerId: r.channelOwnerId,
    channelOwnerName: r.channelOwner?.name ?? null,
    salesOwnerId: r.salesOwnerId,
    salesOwnerName: r.salesOwner.name,
    signedAmount: r.contracts.reduce((s, c) => s + 签约金额(c), 0),
    signedTotals: 签约合计(r.contracts),
    /** 在公海里：负责人那一格写「公海（原 X）」，行上能领取。null = 不在 */
    pool: r.pool ? { reason: r.pool.reason } : null,
    /** 外贸档案：国家、WhatsApp、微信、邮箱、来源（2026-10-05） */
    // WhatsApp 也是号码：共享试用区和电话一样打码
    extra: (() => { const x = 取档案(r.extra); return { ...x, whatsapp: x.whatsapp && 号(x.whatsapp) }; })(),
    // 并发闸门：编辑框拿它作为「我看到的是哪一版」
    updatedAt: r.updatedAt.toISOString(),
  };
}

export type 客户行 = ReturnType<typeof 成客户行>;
