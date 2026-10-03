/**
 * 带分机的号码怎么查重（第三轮 B4 → 第四轮 B3/B4/B5 改成现在这样）。
 *
 * 0.46.15 起号码里留着分机（「01012345678转801」）；之前的版本把分机丢了，老库里同一个人存的是「01012345678」。
 * 只按整串比，同一张老表再导一次就重复建人；可「主号也认」不能对谁都认——0.46.15 之后新录的公司总机
 * 「01012345678」是另一个人（前台），同一总机下带分机的人都会被它挡住。
 *
 * 所以：**主号只认「分机开始留着」之前建的老记录**。那一刻记在设置 `phone.extKeptSince`（毫秒），
 * 升级后第一次打开应用时由 (app)/layout 补记一次（迁移目录不许 INSERT，见 tests/migrations.test.ts）。
 * 记不到的库（还没打开过页面）当成没有老记录：只按整串比，宁可漏认、不认错人。
 */
import type { Prisma } from "@/generated/prisma";
import { getSetting, setSetting } from "./settings";
import { 主号 } from "./phone";

const 键 = "phone.extKeptSince";

export async function 分机留存起(): Promise<Date | null> {
  const v = await getSetting<number>(键);
  return typeof v === "number" && v > 0 ? new Date(v) : null;
}

/** 没记过就记成现在。只写一次，之后再调什么都不做 */
export async function 记下分机留存起(): Promise<void> {
  if ((await getSetting<number>(键)) == null) await setSetting(键, Date.now());
}

/** 表单查重、保存、线索转客户用：整串一样的，或者（带分机时）老库里只存了主号的那位 */
export function 同号条件(phone: string, 起: Date | null): Prisma.CustomerWhereInput {
  const m = 主号(phone);
  return m !== phone && 起 ? { OR: [{ phone }, { phone: m, createdAt: { lt: 起 } }] } : { phone };
}

type 记录 = { phone: string; createdAt: Date };

/**
 * 导入用的认人表。预览和执行共用，两边的数才对得上。
 *   - 整串对上的优先
 *   - 带分机、整串没对上的，才去认老库里只存了主号的人；同一批里两行以上认到同一位老客户（分机不同的几个人，
 *     或者总机那一行加分机那一行），带分机的那几行谁也不认（说不清）——不然补空时两个人的信息写进同一张档案（第四轮 B4、第五轮 B1）
 *   - 这一批里刚建的人只进整串那张表（第四轮 B3：先建了总机，后一行带分机的不该被认成他）
 */
export function 认人表<T extends 记录>(库里: T[], 这一批号码: string[], 起: Date | null) {
  const 整串 = new Map<string, T[]>();
  for (const c of 库里) 整串.set(c.phone, [...(整串.get(c.phone) ?? []), c]);
  const 老主号 = new Map<string, T[]>();
  if (起) for (const c of 库里) if (!c.phone.includes("转") && c.createdAt < 起) 老主号.set(c.phone, [...(老主号.get(c.phone) ?? []), c]);
  const 认到几行 = new Map<string, number>();
  for (const p of new Set(这一批号码)) {
    const m = 主号(p);
    if (m !== p && !整串.has(p) && 老主号.has(m)) 认到几行.set(m, (认到几行.get(m) ?? 0) + 1);
    // 整串就是那个老总机的一行（前台）也算一行：它占着这位老客户，同批带分机的人再靠主号认到他就说不清了（第五轮 B1）
    if (m === p && 老主号.has(p)) 认到几行.set(p, (认到几行.get(p) ?? 0) + 1);
  }
  return {
    认(p: string): { n: number; 旧?: T; 说法?: string } {
      const 整 = 整串.get(p);
      if (整) return { n: 整.length, 旧: 整.length === 1 ? 整[0] : undefined, 说法: 整.length > 1 ? `库里有 ${整.length} 位都是这个号码，不知道该算谁的` : undefined };
      const m = 主号(p);
      const 老 = m !== p ? 老主号.get(m) : undefined;
      if (!老) return { n: 0 };
      if ((认到几行.get(m) ?? 0) > 1) return { n: 2, 说法: `表里几位分机不同的人都对上了库里同一位（只存了总机 ${m}），不知道该算谁的` };
      return { n: 老.length, 旧: 老.length === 1 ? 老[0] : undefined, 说法: 老.length > 1 ? `库里有 ${老.length} 位都是总机 ${m}，不知道该算谁的` : undefined };
    },
    /** 这一批刚建的：只进整串那张表 */
    记下(c: T) {
      整串.set(c.phone, [...(整串.get(c.phone) ?? []), c]);
    },
  };
}
