/**
 * 企业版「交接中」（2026-10-26，测试清单 D10：转出去的数据，交接完成前接手人看不到）。
 *
 * 规则「交接要接手人确认」开着时（规则开着 自带 企业版()）：
 *   离职交接 —— 发起时成员立刻停用、放进公海的那部分立刻放；给接手人的那部分（客户、商机、待办、线索、渠道、项目）
 *               先不动，留在他名下，记一行 EntHandover 待确认，接手人确认了才按当时重新分拣、转过去
 *   转让客户 —— 批量分配给别人（不是给自己）时，客户先不换负责人，按原负责人一人一行记待确认；接手人确认了才换，
 *               名下联系人、沟通记录、项目、没做完的活照转让客户的老规矩一起走（带走并记下）
 * 确认之前数据还归原负责人，接手人的列表里自然没有；接手人只在「等你确认的交接」里看到个数和客户名。
 * 规则关着、不是企业版：一行都不写，离职、转让和原来一样当场转（开关关掉的测试见 tests/ent-handover.test.ts）。
 *
 * 状态：待确认 → 已确认（接手人）/ 已撤回（发起人、管理员；成员重新启用也会撤）/ 已拒收（接手人）。
 * 离职交接撤回或拒收后成员仍是停用的，数据留在他名下：要换接手人就再办一次离职，或先恢复成员
 */
import type { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { 看全部 } from "@/lib/team-scope";
import { 规则开着 } from "./rules";

export type 交接种类 = "离职" | "转让";
export type 交接状态 = "待确认" | "已确认" | "已撤回" | "已拒收";
export const 待确认: 交接状态 = "待确认";

/** 现在要不要走「交接中」：企业版且规则开着 */
export function 交接要确认(): Promise<boolean> {
  return 规则开着("交接要确认");
}

export function 读ids(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

type 库 = Pick<Prisma.TransactionClient, "entHandover">;

/** 这几位里正在转让交接中的（同一位客户不能同时交给两个人）。看全部：别人发起的交接也要数上 */
export async function 交接中的客户(ids: string[], db: 库 = prisma): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const 要 = new Set(ids);
  const 行 = await 看全部(() => db.entHandover.findMany({ where: { kind: "转让", status: 待确认 }, select: { customerIds: true } }));
  return new Set(行.flatMap((r) => 读ids(r.customerIds)).filter((id) => 要.has(id)));
}

/** 这位成员有没有还没确认的离职交接 */
export function 离职交接中(userId: string, db: 库 = prisma) {
  return 看全部(() => db.entHandover.findFirst({ where: { kind: "离职", fromUserId: userId, status: 待确认 } }));
}

/**
 * 把一行从待确认改成别的状态：带着 status 条件改，两个人同时点（接手人确认、发起人撤回）只成一个。
 * 改成了返回 true
 */
export async function 了结(db: 库, id: string, 状态: Exclude<交接状态, "待确认">, 谁: string, 额外?: Prisma.EntHandoverWhereInput): Promise<boolean> {
  const r = await db.entHandover.updateMany({
    where: { id, status: 待确认, ...额外 },
    data: { status: 状态, doneAt: new Date(), doneById: 谁 },
  });
  return r.count === 1;
}
