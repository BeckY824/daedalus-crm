/**
 * 问数据的取数：把受限的 QuerySpec 变成 Prisma 查询并聚合。
 * 报表页的「问数据」和首页的 agent 工具共用。模型永远碰不到数据库，
 * 能查什么在 report-query.ts 里白纸黑字。
 */
import type { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { 签约归属人 } from "./contract-owner";
import { 带币种, 签约币种, 签约金额 } from "./money-db";
import { dayjs } from "./utils";
import { FOLLOW_TYPE_MAP } from "./constants";
import { sumRows, rateRows, bucketMonth, type QuerySpec, type ResultRow, type GroupBy } from "./report-query";
import type { BusinessConfig } from "./business-config";
import { statusLabel } from "./business-config";

function dateWhere(field: string, spec: QuerySpec) {
  const cond: Record<string, Date> = {};
  if (spec.from) cond.gte = dayjs(spec.from).startOf("day").toDate();
  if (spec.to) cond.lte = dayjs(spec.to).endOf("day").toDate();
  return Object.keys(cond).length ? { [field]: cond } : {};
}

/** 归组 key/label。key 用 id（姓名可重复，按名归组会把两个人加进同一行） */
function keyOf(groupBy: GroupBy | null, when: Date, dims: Record<string, { id: string; label: string } | string | null>) {
  if (groupBy === "month") {
    const m = bucketMonth(when);
    return { key: m, label: m };
  }
  const d = groupBy ? dims[groupBy] : null;
  if (groupBy && (d == null || d === "")) return { key: "__none__", label: "未填/未分配" };
  if (typeof d === "string") return { key: d, label: d };
  if (d) return { key: d.id, label: d.label };
  return { key: "__all__", label: "全部" };
}

export async function runQuery(spec: QuerySpec, b: BusinessConfig, customerWhere?: Prisma.CustomerWhereInput): Promise<ResultRow[]> {
  const byMonth = spec.groupBy === "month";

  if (spec.metric === "leads_count" || spec.metric === "lead_conversion") {
    const leads = await prisma.lead.findMany({
      where: dateWhere("createdAt", spec),
      select: { createdAt: true, source: true, status: true, owner: { select: { id: true, name: true } } },
    });
    const shaped = leads.map((l) => ({
      ...keyOf(spec.groupBy, l.createdAt, { source: l.source, sales: l.owner ? { id: l.owner.id, label: l.owner.name } : null }),
      converted: l.status === "已转化" ? 1 : 0,
    }));
    if (spec.metric === "leads_count") return sumRows(shaped.map((s) => ({ key: s.key, label: s.label, value: 1 })), { byMonth });
    return rateRows(shaped.map((s) => ({ key: s.key, label: s.label, created: 1, converted: s.converted })), { byMonth });
  }

  if (spec.metric === "customers_count") {
    const customers = await prisma.customer.findMany({
      where: { AND: [dateWhere("createdAt", spec), ...(customerWhere ? [customerWhere] : [])] },
      select: { createdAt: true, grade: true, followStatus: true, decisionStatus: true, salesOwner: { select: { id: true, name: true } }, channel: { select: { id: true, name: true } } },
    });
    return sumRows(
      customers.map((c) => ({
        ...keyOf(spec.groupBy, c.createdAt, {
          sales: { id: c.salesOwner.id, label: c.salesOwner.name },
          channel: c.channel ? { id: c.channel.id, label: c.channel.name } : null,
          grade: c.grade,
          followStatus: statusLabel(b, c.followStatus),
          decisionStatus: statusLabel(b, c.decisionStatus),
        }),
        value: 1,
      })),
      { byMonth },
    );
  }

  if (spec.metric === "contract_amount" || spec.metric === "contract_count") {
    const contracts = await prisma.contract.findMany({
      where: { ...dateWhere("signedAt", spec), ...(customerWhere ? { customer: { is: customerWhere } } : {}) },
      select: {
        amount: true, signedAt: true,
        ...带币种.签约,
        owner: { select: { salesOwnerId: true, channelOwnerId: true } },
        customer: { select: { salesOwner: { select: { id: true, name: true, email: true } }, channel: { select: { id: true, name: true } } } },
      },
    });
    // 按销售拆时算在签约那一刻的负责人头上，和数据页同一份规则（排查 B2，lib/contract-owner.ts）
    const 归属 = await 签约归属人(contracts);
    // 金额按币种分行（不换汇）：同一个人签了美元也签了人民币，就是两行。只有一种币时行名不加后缀
    const 金额 = spec.metric === "contract_amount";
    const 多币 = 金额 && new Set(contracts.map(签约币种)).size > 1;
    return sumRows(
      contracts.map((c) => {
        const 销售 = 归属.销售(c);
        const k = keyOf(spec.groupBy, c.signedAt, {
          sales: 销售 ? { id: 销售.id, label: 销售.name } : null,
          channel: c.customer.channel ? { id: c.customer.channel.id, label: c.customer.channel.name } : null,
        });
        if (!金额) return { ...k, value: 1 };
        const 币 = 签约币种(c);
        return { key: `${k.key}|${币}`, label: 多币 ? `${k.label}（${币}）` : k.label, value: 签约金额(c), currency: 币 };
      }),
      { byMonth },
    );
  }

  const followUps = await prisma.followUp.findMany({
    where: { ...dateWhere("occurredAt", spec), ...(customerWhere ? { customer: { is: customerWhere } } : {}) },
    select: { occurredAt: true, type: true, owner: { select: { id: true, name: true } } },
  });
  return sumRows(
    followUps.map((f) => ({
      ...keyOf(spec.groupBy, f.occurredAt, { sales: { id: f.owner.id, label: f.owner.name }, type: FOLLOW_TYPE_MAP[f.type]?.label ?? f.type }),
      value: 1,
    })),
    { byMonth },
  );
}
