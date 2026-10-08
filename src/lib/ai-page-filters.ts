/** 客户页筛选的协议白名单。只收条件，不接受SQL、权限或任意Prisma表达式。 */
export const 客户页面筛选键 = ["keyword", "grade", "followStatus", "decisionStatus", "salesOwnerId", "channelOwnerId", "createdWithin", "directOf", "batch", "pool", "country", "source"] as const;
export type 页面客户筛选 = Partial<Record<(typeof 客户页面筛选键)[number], string>>;
export function 收客户页面筛选(value: unknown): 页面客户筛选 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: 页面客户筛选 = {};
  for (const [key, val] of Object.entries(value)) {
    if (!(客户页面筛选键 as readonly string[]).includes(key) || typeof val !== "string" || val.length > 200) return null;
    const text = val.trim();
    if (text) result[key as keyof 页面客户筛选] = text;
  }
  return result;
}
