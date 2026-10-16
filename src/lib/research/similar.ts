/**
 * 「像不像老客户」的材料：从这台机器的 CRM 里挑出已成交 / 在谈的客户（10-16 用户定的第 6 维）。
 *
 * 只挑、不比：比是模型在「相关性」那一步做的（它手上有这家公司查到的材料），这里只负责
 * 把老客户整理成一张短表交过去，并在模型回来以后核对它说的那几位真在表里。
 *
 * 发给模型的只有：公司名、国家、三个档案字段（外贸里是公司 / 职位 / 行业那一类）、成交还是在谈。
 * **不发跟进记录原文、电话、邮箱、WhatsApp**——方案里写给用户的承诺，测试钉着。
 *
 * 可见范围：prisma 客户端本身按当前用户限定（团队版业务员只看得到自己的和公海），
 * 所以这里查到的就是「你能看到的」，不用另外加条件。
 */
import { prisma } from "../prisma";
import type { BusinessConfig } from "../business-config";
import type { 像的老客户 } from "./types";

/** 最多比几位。再多提示词就长了，而「像不像」看最近的一批就够 */
export const 老客户上限 = 30;

export type 老客户 = { id: string; name: string; 国家: string | null; 档案: string; 状态: "已成交" | "在谈" };

export async function 老客户清单(b: Pick<BusinessConfig, "fields">): Promise<老客户[]> {
  const rows = await prisma.customer.findMany({
    where: {
      OR: [
        { followStatus: { in: ["已签约", "意向较高"] } },
        { contracts: { some: {} } },
        { tradeOrders: { some: {} } },
        { opportunities: { some: {} } },
      ],
    },
    select: {
      id: true,
      name: true,
      school: true,
      grade: true,
      major: true,
      followStatus: true,
      extra: { select: { country: true } },
      _count: { select: { contracts: true, tradeOrders: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 老客户上限,
  });
  return rows.map((r) => {
    const 成交 = r.followStatus === "已签约" || r._count.contracts > 0 || r._count.tradeOrders > 0;
    const 档案 = [
      r.school && `${b.fields.school}：${r.school}`,
      r.grade && `${b.fields.grade}：${r.grade}`,
      r.major && `${b.fields.major}：${r.major}`,
    ]
      .filter(Boolean)
      .join("；");
    return { id: r.id, name: r.name, 国家: r.extra?.country ?? null, 档案, 状态: 成交 ? "已成交" : "在谈" };
  });
}

/** 拼进提示词的那张表。编号从 1 起，模型按编号回，不按名字（重名、拼写变体都会认错人） */
export function 老客户表文本(list: 老客户[]): string {
  if (!list.length) return "（还没有已成交或在谈的客户）";
  return list.map((c, i) => `${i + 1}. ${c.name}｜${c.状态}｜${c.国家 ?? "国家未填"}${c.档案 ? `｜${c.档案}` : ""}`).join("\n");
}

/**
 * 模型回来的「像哪几位」，按编号对回老客户表。不可信：编号越界、重复、档写错的都丢掉，最多留 3 位。
 */
export function 认像的老客户(原始: unknown, list: 老客户[]): 像的老客户[] {
  if (!Array.isArray(原始)) return [];
  const 出: 像的老客户[] = [];
  const 见过 = new Set<string>();
  for (const x of 原始) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const n = Number(o.编号 ?? o.no ?? o.index);
    const c = Number.isInteger(n) ? list[n - 1] : undefined;
    const 档 = o.档 ?? o.grade;
    const 像在哪 = typeof (o.像在哪 ?? o.reason) === "string" ? String(o.像在哪 ?? o.reason).trim().slice(0, 80) : "";
    if (!c || 见过.has(c.id) || (档 !== "high" && 档 !== "mid" && 档 !== "low") || !像在哪) continue;
    见过.add(c.id);
    出.push({ id: c.id, name: c.name, 档, 像在哪 });
    if (出.length >= 3) break;
  }
  // 最像的排前面
  const 序 = { high: 0, mid: 1, low: 2 } as const;
  return 出.sort((a, b) => 序[a.档] - 序[b.档]);
}

/** 第 6 维的档：取最像那一位的档；比了但一位都不像 = low；没有老客户可比 = unknown（不进分母） */
export function 老客户维度档(items: 像的老客户[], 比了: number): "high" | "mid" | "low" | "unknown" {
  if (!比了) return "unknown";
  return items[0]?.档 ?? "low";
}
