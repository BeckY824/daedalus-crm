/**
 * 外贸：没有电话、也没有 WhatsApp 的客户按邮箱认人（2026-10-07，用户拍板）。
 *
 * 小满导出里邮件开发来的客户常常只有邮箱，原来认人锁电话 / WhatsApp，整行进不来、表单也存不了。
 * 只在**这一条没有电话**的时候拿邮箱认人：有电话的照旧只按电话认（同一公司几位联系人共用 info@ 的常见，
 * 拿邮箱去挡有电话的人会挡错）。邮箱存的是人填的原样，比的时候去空格、不分大小写——Anna@X.de 和 anna@x.de 是同一位。
 *
 * 和号键查重一样用裸 SQL（不过团队版限定）：查重本来就要看全部，调用方拿 id 再查、包在 看全部 里。
 */
import type { Prisma } from "@/generated/prisma";

/** 比邮箱用的键：去首尾空格、小写。空的返回空串 */
export const 邮箱键 = (e: string | null | undefined): string => String(e ?? "").trim().toLowerCase();

type 能裸查 = { $queryRawUnsafe: Prisma.TransactionClient["$queryRawUnsafe"] };

/** 邮箱（按键比）在这几个里的客户：客户 id + 库里那格的键。一次 500 个，导入几千行也放得进参数上限 */
export async function 按邮箱找(db: 能裸查, 邮箱们: string[]): Promise<{ id: string; 键: string }[]> {
  const 键们 = [...new Set(邮箱们.map(邮箱键).filter(Boolean))];
  const 出: { id: string; 键: string }[] = [];
  for (let i = 0; i < 键们.length; i += 500) {
    const 段 = 键们.slice(i, i + 500);
    出.push(...(await db.$queryRawUnsafe<{ id: string; 键: string }[]>(
      `SELECT "customerId" AS id, lower(trim("email")) AS 键 FROM "CustomerExtra" WHERE lower(trim("email")) IN (${段.map(() => "?").join(", ")})`,
      ...段,
    )));
  }
  return 出;
}

/** 表单保存、导入落库前那一下：邮箱一样的客户，按 id 的 Prisma 条件（db 传事务就在事务里查） */
export async function 同邮箱条件(db: 能裸查, email: string): Promise<Prisma.CustomerWhereInput> {
  return { id: { in: (await 按邮箱找(db, [email])).map((r) => r.id) } };
}

/**
 * 导入用的邮箱认人表（同 phone-dedupe 的 认人表，只是没有分机那一套）：
 * 库里一位对上就是他；两位以上对上谁也不认（说不清）；这一批刚建的记下来，后面同邮箱的行不再建
 */
export function 邮箱认人表<T extends { id: string }>(库里: { 客户: T; 键: string }[]) {
  const 表 = new Map<string, T[]>();
  for (const { 客户, 键 } of 库里) if (键) 表.set(键, [...(表.get(键) ?? []).filter((c) => c.id !== 客户.id), 客户]);
  return {
    认(email: string): { n: number; 旧?: T; 说法?: string } {
      const 有 = 表.get(邮箱键(email)) ?? [];
      return { n: 有.length, 旧: 有.length === 1 ? 有[0] : undefined, 说法: 有.length > 1 ? `库里有 ${有.length} 位都是这个邮箱，不知道该算谁的` : undefined };
    },
    记下(email: string, c: T) {
      const k = 邮箱键(email);
      if (k) 表.set(k, [...(表.get(k) ?? []), c]);
    },
  };
}
