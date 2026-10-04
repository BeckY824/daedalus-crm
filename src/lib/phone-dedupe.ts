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
import { 主号, 号键, 号键替换 } from "./phone";

const 键 = "phone.extKeptSince";

export async function 分机留存起(): Promise<Date | null> {
  const v = await getSetting<number>(键);
  return typeof v === "number" && v > 0 ? new Date(v) : null;
}

/** 没记过就记成现在。只写一次，之后再调什么都不做 */
export async function 记下分机留存起(): Promise<void> {
  /*
    吞错（2026-10-04，回归核对 H-017）：它在 (app)/layout 里每次进页面都调，原来是裸 await——
    库锁着、磁盘满时 setSetting 一抛，整个应用一页都打不开，为的只是记一个时间戳。
    没记上下一次进页面会再试；没记上之前查重照旧按整串比，只是少认一种老号码，不伤数据
  */
  try {
    if ((await getSetting<number>(键)) == null) await setSetting(键, Date.now());
  } catch (e) {
    console.error("[phone-dedupe] 记分机留存起点没成，下次再试：", e instanceof Error ? e.message : e);
  }
}

/* ---------------- 号键查库（R-067 / R-069，2026-10-04） ----------------
  库里的老号码可能带着空格、横杠、全角横杠（规整之前的写法，不回填）。查重时库那一侧也要算号键，
  可不能把全表拉进内存现算——1 万客户的库每录一位就扫一遍。所以在 SQL 里用同一张替换表算，
  并给这个式子建了表达式索引（migrations/021-customer-phone-key.sql）：查重是一次索引查找，和原来按 phone 查一样快。
  索引没建上（还没跑迁移的库）也照样对，只是退回全表扫。
*/

export const 号键索引名 = "Customer_phoneKey_idx";

const SQL字面 = (c: string) => (c === "\t" ? "char(9)" : c === "\n" ? "char(10)" : c === "\r" ? "char(13)" : `'${c.replace(/'/g, "''")}'`);

/** 号键的 SQL 写法（和 lib/phone 的 号键 同一张替换表）。迁移里的索引必须是 号键SQL('"phone"') 原样，查询计划才认 */
export function 号键SQL(列: string): string {
  return 号键替换.reduce((e, [从, 到]) => `replace(${e}, ${SQL字面(从)}, ${SQL字面(到)})`, 列);
}

/** 按号键找客户的那一句（n 个键）。导出给用例看查询计划 */
export function 按号键找SQL(n: number): string {
  return `SELECT id, phone FROM "Customer" WHERE ${号键SQL('"phone"')} IN (${Array.from({ length: n }, () => "?").join(", ")})`;
}

type 能裸查 = { $queryRawUnsafe: Prisma.TransactionClient["$queryRawUnsafe"] };

/**
 * 号键在这几个里的客户（id + 库里原样的号码）。**不加团队版的限定**（裸 SQL 不过 Prisma 扩展）：
 * 查重本来就要看全部，调用方再拿 id 去查、包在 看全部 里。一次 500 个键，导入几千行也放得进 SQLite 的参数上限
 */
export async function 按号键找(db: 能裸查, 键们: string[]): Promise<{ id: string; phone: string }[]> {
  const 键 = [...new Set(键们.filter(Boolean))];
  const 出: { id: string; phone: string }[] = [];
  for (let i = 0; i < 键.length; i += 500) {
    const 段 = 键.slice(i, i + 500);
    出.push(...(await db.$queryRawUnsafe<{ id: string; phone: string }[]>(按号键找SQL(段.length), ...段)));
  }
  return 出;
}

/**
 * 表单查重、保存、线索转客户、导入落库前那一下都用这一个：号键一样的，或者（带分机时）老库里只存了主号的那位。
 * 返回按 id 的 Prisma 条件，和别的条件（排除自己）合起来用。db 传事务就在事务里查（J-104 查完再写）
 */
export async function 同号条件(db: 能裸查, phone: string, 起: Date | null): Promise<Prisma.CustomerWhereInput> {
  const k = 号键(phone);
  const m = 号键(主号(phone));
  const 认主号 = m !== k && 起 !== null;
  const 行 = await 按号键找(db, 认主号 ? [k, m] : [k]);
  const 整 = 行.filter((r) => 号键(r.phone) === k).map((r) => r.id);
  const 老 = 认主号 ? 行.filter((r) => 号键(r.phone) === m).map((r) => r.id) : [];
  return 老.length ? { OR: [{ id: { in: 整 } }, { id: { in: 老 }, createdAt: { lt: 起! } }] } : { id: { in: 整 } };
}

/** 导入用：这一批号码（连同带分机的主号）号键对得上的库里客户的 id，拿去 findMany 取认人表要的那些列 */
export async function 这一批同号的(db: 能裸查, 号码们: string[]): Promise<Prisma.CustomerWhereInput> {
  const 行 = await 按号键找(db, 号码们.flatMap((p) => [号键(p), 号键(主号(p))]));
  return { id: { in: 行.map((r) => r.id) } };
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
  // 两张表都按号键认（R-067 / R-069）：库里的「138 0000 1111」和表里的 13800001111 是同一位
  const 整串 = new Map<string, T[]>();
  for (const c of 库里) 整串.set(号键(c.phone), [...(整串.get(号键(c.phone)) ?? []), c]);
  const 老主号 = new Map<string, T[]>();
  if (起) for (const c of 库里) if (!c.phone.includes("转") && c.createdAt < 起) 老主号.set(号键(c.phone), [...(老主号.get(号键(c.phone)) ?? []), c]);
  const 认到几行 = new Map<string, number>();
  for (const k of new Set(这一批号码.map(号键))) {
    const m = 号键(主号(k));
    if (m !== k && !整串.has(k) && 老主号.has(m)) 认到几行.set(m, (认到几行.get(m) ?? 0) + 1);
    // 整串就是那个老总机的一行（前台）也算一行：它占着这位老客户，同批带分机的人再靠主号认到他就说不清了（第五轮 B1）
    if (m === k && 老主号.has(k)) 认到几行.set(k, (认到几行.get(k) ?? 0) + 1);
  }
  return {
    认(p: string): { n: number; 旧?: T; 说法?: string } {
      const k = 号键(p);
      const 整 = 整串.get(k);
      if (整) return { n: 整.length, 旧: 整.length === 1 ? 整[0] : undefined, 说法: 整.length > 1 ? `库里有 ${整.length} 位都是这个号码，不知道该算谁的` : undefined };
      const m = 号键(主号(k));
      const 老 = m !== k ? 老主号.get(m) : undefined;
      if (!老) return { n: 0 };
      if ((认到几行.get(m) ?? 0) > 1) return { n: 2, 说法: `表里几位分机不同的人都对上了库里同一位（只存了总机 ${m}），不知道该算谁的` };
      return { n: 老.length, 旧: 老.length === 1 ? 老[0] : undefined, 说法: 老.length > 1 ? `库里有 ${老.length} 位都是总机 ${m}，不知道该算谁的` : undefined };
    },
    /** 这一批刚建的：只进整串那张表 */
    记下(c: T) {
      整串.set(号键(c.phone), [...(整串.get(号键(c.phone)) ?? []), c]);
    },
  };
}
