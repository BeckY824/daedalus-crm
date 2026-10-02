/**
 * r2-data 这一轮（2026-10-02 二轮排查：异常路径与边界数据）几份测试共用的造数小工具。
 *
 * 只造「库里本来就该有」的东西（成员、客户、计划……），直接写 prisma；
 * 被测的那一步一律调真实的 Server Action，和 tests/concurrency.test.ts 同一个做法。
 * vi.mock 必须写在各自的测试文件里（会被提升），这里不碰。
 */
import { prisma } from "@/lib/prisma";

/** 桌面端的典型库：一个人、一个管理员 */
export async function 造本人() {
  return prisma.user.create({
    data: { email: "me@local", name: "我", title: "管理员", role: "ADMIN", password: "x" },
  });
}

let 序 = 0;
/** 一位客户。号码默认不撞 */
export async function 造客户(销售: string, extra: Record<string, unknown> = {}) {
  序++;
  return prisma.customer.create({
    data: { name: `客户${序}`, phone: `1390000${String(序).padStart(4, "0")}`, salesOwnerId: 销售, ...extra },
  });
}

/** 捕获「抛异常」和「返回 {ok:false}」两种失败：界面上前者是没反应，后者是一句话 */
export async function 结局<T>(p: Promise<T>): Promise<{ 抛了: true; 错: string } | { 抛了: false; 值: T }> {
  try {
    return { 抛了: false, 值: await p };
  } catch (e) {
    return { 抛了: true, 错: e instanceof Error ? e.message.split("\n").slice(-3).join(" ") : String(e) };
  }
}

/** 本地时间的一个时刻（不是 UTC），日期类断言都按它造 */
export function 本地(y: number, m: number, d: number, h = 0, mi = 0): Date {
  return new Date(y, m - 1, d, h, mi);
}
