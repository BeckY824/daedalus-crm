/**
 * 一个名字在库里到底在哪张表。
 *
 * **「找一个人」原来只有 `search_customers` 一条路。** 客户表搜空之后模型手上一条线索都没有，
 * 只能反过来问人：「你给个更完整的姓名或公司名，我再查一次」——而那个人可能就好好地
 * 躺在渠道表里。2026-09-19 报上来的：首页问「明杰哥的电话是多少」，明杰哥是一个渠道，
 * 客户库里当然没有，于是连问两次都是「没找到」。
 *
 * 页面上下文（lib/ai-context-page.ts）只在渠道页上盖住了这个洞——首页没有页面上下文，
 * 而首页正是这个 agent 的主场。所以修在工具层：**搜空这件事本身要带上答案。**
 *
 * 不是给模型一句「你去别处看看」的提示，而是直接把别处那几条记录连电话一起给它：
 * 一次工具调用就够，不用第二次往返，也不依赖模型愿不愿意跟进那句提示。
 *
 * 只查有人名、且人会问「他电话多少」的四张表。商机、合同不查——那不是人。
 */
import { prisma } from "../prisma";

/** 一张表里的命中 */
export type 别处命中 = {
  表: string;
  条数: number;
  /** 前几条，带电话（已过脱敏器）。给模型直接作答用 */
  记录: Record<string, unknown>[];
  /** 要更多 / 要详情时该用哪个工具 */
  怎么查: string;
};

const 每表最多 = 5;

/**
 * @param 名 用户问的那个词。空串直接返回空
 * @param 号 号码脱敏器（共享工作区打码）。**必须传**，否则会绕开那道闸
 */
export async function 名字在别处(名: string, 号: (p: string | null) => string | null): Promise<别处命中[]> {
  const q = 名.trim();
  if (!q) return [];

  const [渠道, 联系人, 线索, 成员] = await Promise.all([
    prisma.channel.findMany({
      where: { name: { contains: q } },
      take: 每表最多,
      select: { name: true, phone: true, active: true, remark: true, channelOwner: { select: { name: true } } },
    }),
    prisma.contact.findMany({
      where: { name: { contains: q } },
      take: 每表最多,
      select: { name: true, phone: true, position: true, wechat: true, customer: { select: { name: true } } },
    }),
    prisma.lead.findMany({
      // 线索有两个人名字段：线索本身的名称（多半是公司）和它的联系人
      where: { OR: [{ name: { contains: q } }, { contact: { contains: q } }] },
      take: 每表最多,
      select: { name: true, contact: true, phone: true, status: true },
    }),
    prisma.user.findMany({
      where: { name: { contains: q } },
      take: 每表最多,
      select: { name: true, title: true, role: true, active: true },
    }),
  ]);

  const out: 别处命中[] = [];
  if (渠道.length)
    out.push({
      表: "渠道",
      条数: 渠道.length,
      记录: 渠道.map((c) => ({ 名称: c.name, 电话: 号(c.phone), 渠道负责人: c.channelOwner?.name ?? "未指定", 状态: c.active ? "在用" : "已停用", 备注: c.remark ?? null })),
      怎么查: `list_channels（keyword="${q}"）`,
    });
  if (联系人.length)
    out.push({
      表: "联系人",
      条数: 联系人.length,
      记录: 联系人.map((c) => ({ 姓名: c.name, 电话: 号(c.phone), 职位: c.position ?? null, 微信: c.wechat ?? null, 属于: c.customer?.name ?? null })),
      怎么查: `query_records（表=联系人）`,
    });
  if (线索.length)
    out.push({
      表: "线索",
      条数: 线索.length,
      记录: 线索.map((l) => ({ 线索: l.name, 联系人: l.contact ?? null, 电话: 号(l.phone), 状态: l.status })),
      怎么查: `list_leads（keyword="${q}"）`,
    });
  if (成员.length)
    out.push({
      表: "团队成员",
      条数: 成员.length,
      // 成员不给电话：那是同事的私人号码，不是客户资料
      记录: 成员.map((u) => ({ 姓名: u.name, 职务: u.title ?? null, 角色: u.role, 状态: u.active ? "在职" : "已停用" })),
      怎么查: `list_users（keyword="${q}"）`,
    });
  return out;
}

/**
 * 按名字把**这个库里所有长着人名的表**找一遍：客户、渠道、联系人、线索、团队成员。
 *
 * 这是 `find_person` 工具的身子。为什么非要有这么一个工具：
 * `search_customers` 是「找**客户**」，不是「找人」。而人问「明杰哥的电话是多少」时，
 * 他不知道也不关心明杰哥在这套系统里被登记成了客户、渠道还是联系人——
 * 那是我们的表结构，不是他的问题。
 *
 * 没有这个工具的时候，模型每次都在十一个工具里挑一个最像的：这一次挑了
 * `search_customers`，下一次挑了 `list_users`（还把「李老师」截成「李」去搜团队成员）。
 * 挑错不报错，只是答「没找到」，而那个人好好地躺在另一张表里。
 */
export async function 找人(名: string, 号: (p: string | null) => string | null): Promise<别处命中[]> {
  const q = 名.trim();
  if (!q) return [];
  const [客户, 其余] = await Promise.all([
    prisma.customer.findMany({
      where: { name: { contains: q } },
      take: 每表最多,
      orderBy: { lastFollowAt: "desc" },
      select: { id: true, name: true, phone: true, school: true, grade: true, followStatus: true, salesOwner: { select: { name: true } } },
    }),
    名字在别处(q, 号),
  ]);
  const out: 别处命中[] = [];
  if (客户.length)
    out.push({
      表: "客户",
      条数: 客户.length,
      记录: 客户.map((c) => ({ id: c.id, 姓名: c.name, 电话: 号(c.phone), 学校或公司: c.school, 年级或职位: c.grade, 跟进状态: c.followStatus, 负责人: c.salesOwner.name })),
      怎么查: `get_customer（id=…）读这一位的完整档案和跟进时间线`,
    });
  return [...out, ...其余];
}

/** 给过程条看的一句话（工具 summary 只进界面，不进模型）。没命中返回空串 */
export function 别处说法(名: string, 命中: 别处命中[]): string {
  if (!命中.length) return "";
  const 段 = 命中.map((h) => `**${h.表}**里有 ${h.条数} 条（${h.记录.map((r) => String(Object.values(r)[0])).join("、")}）`).join("；");
  return `——但「${名}」${段}。要的多半就是这个，直接据此回答，不用再问用户。`;
}

/**
 * 塞进工具 `data` 的那一段。**模型只看得见 data**（run.ts 里 tool 消息的内容就是
 * `JSON.stringify(result.data)`，summary 只进过程条），所以「接下来该怎么办」这句话
 * 必须写在这儿——写在 summary 里等于没写。
 */
export function 别处附件(名: string, 命中: 别处命中[]): Record<string, unknown> | null {
  if (!命中.length) return null;
  return {
    这个名字在别的表里: 命中,
    该怎么办: `「${名}」不在客户表里，但上面这几条就是它。直接照这些记录回答（电话、状态、备注都在里面）；` + `不要说「没找到」，也不要反过来让用户给更完整的姓名或公司名。`,
  };
}
