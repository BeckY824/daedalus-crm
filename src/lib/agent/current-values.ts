import type { Prisma } from "@/generated/prisma";
import { prisma } from "../prisma";
import { dayjs } from "../utils";

/**
 * 建议卡上「改之前是什么」的那一份值（字段名 → 现在显示成什么）。
 *
 * 两处用：生成卡片时记下来给人看（tools.ts）；人点确认时再取一份和卡上的比（dashboard/apply.ts，排查 D4）——
 * 卡片出来之后同事改过同一格，就不能拿卡上的旧判断盖掉人家刚改的。两处必须是同一个算法，所以只写这一份。
 *
 * **phone 不打码**：这是预填值，人点确认之后会原样写回库，打了码就是把假号存进去
 * （tests/agent-phone-mask.test.ts 里那条具名例外说的就是它）。
 */
export const 现值选取 = {
  id: true, name: true, phone: true, school: true, grade: true, major: true,
  followStatus: true, decisionStatus: true, expectedSignAt: true, expectedSignOn: true, remark: true,
  salesOwner: { select: { name: true } },
  channelOwner: { select: { name: true } },
  channel: { select: { name: true } },
  referrerCustomer: { select: { name: true } },
} satisfies Prisma.CustomerSelect;

export type 现值客户 = Prisma.CustomerGetPayload<{ select: typeof 现值选取 }>;

export function 现值表(found: 现值客户): Record<string, string> {
  return {
    name: found.name,
    phone: found.phone ?? "",
    school: found.school ?? "",
    grade: found.grade ?? "",
    major: found.major ?? "",
    followStatus: found.followStatus,
    decisionStatus: found.decisionStatus,
    expectedSignAt: found.expectedSignOn ?? (found.expectedSignAt ? dayjs(found.expectedSignAt).format("YYYY-MM-DD") : ""),
    remark: found.remark ?? "",
    salesOwnerName: found.salesOwner?.name ?? "",
    channelOwnerName: found.channelOwner?.name ?? "",
    channelName: found.channel?.name ?? "",
    referrerName: found.referrerCustomer?.name ?? "",
  };
}

export async function 读现值(customerId: string): Promise<Record<string, string> | null> {
  const found = await prisma.customer.findUnique({ where: { id: customerId }, select: 现值选取 });
  return found ? 现值表(found) : null;
}
