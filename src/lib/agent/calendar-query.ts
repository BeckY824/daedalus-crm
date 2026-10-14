import { scheduleOrder } from "../schedule-date";

/** 只允许已有白名单字段对应的内部元数据；模型不能指定元数据列。 */
export const calendarColumns: Record<string, Record<string, string>> = {
  客户: { expectedSignAt: "expectedSignOn" },
  跟进计划: { plannedAt: "plannedOn" },
  任务: { dueAt: "dueOn" },
};

/**
 * 原日历日在切换时区后不再与旧索引瞬间同序。按稳定ID逐批读并只保留前take行，
 * 避免先按旧瞬间截取而永远漏掉应排在前面的日期记录。每批仍走带权限的Prisma查询。
 */
export async function readCalendarSorted(
  read: (args: unknown) => Promise<Record<string, unknown>[]>,
  where: Record<string, unknown>, select: Record<string, unknown>, take: number,
  atColumn: string, onColumn: string, direction: "asc" | "desc",
): Promise<Record<string, unknown>[]> {
  let cursor: string | undefined; let first: Record<string, unknown>[] = [];
  const compare = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    const time = (r: Record<string, unknown>) => scheduleOrder(r[atColumn] as Date | null, r[onColumn] as string | null);
    // Prisma默认升序NULL在前、降序在后；有限值按日历语义排。
    const av = time(a), bv = time(b);
    const base = av === bv ? 0 : av === Infinity ? -1 : bv === Infinity ? 1 : av - bv;
    return (direction === "asc" ? base : -base) || String(a.id).localeCompare(String(b.id));
  };
  for (;;) {
    const batch = await read({ where: { AND: [where, ...(cursor ? [{ id: { gt: cursor } }] : [])] }, select, orderBy: { id: "asc" }, take: 1000 });
    first = [...first, ...batch].sort(compare).slice(0, take);
    if (batch.length < 1000) return first;
    cursor = String(batch.at(-1)!.id);
  }
}
