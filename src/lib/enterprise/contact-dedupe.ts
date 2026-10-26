/**
 * 企业版建档的全公司号码查重（2026-10-26，测试清单 B8）。格式规矩在 lib/enterprise/contact-format.ts。
 *
 * 对方原来的系统建档先查号码：全公司不分谁名下、不分在客户上还是联系人上，撞到就不让建，并说清是哪种撞法。
 * 这里一律看全部（看全部 + 裸 SQL），撞到以后给人看的样子按 看得到 收（看不到的不给 id、名字、学校、建档时间），
 * 只留负责人名字：提示原文就是「可与 X 沟通核实」。
 *
 * 比哪几处：
 * - 手机号：客户的电话（同号条件，和 checkDuplicate 同一条；国内号多认一种带 86 的老写法）+ 联系人的电话（号键比）
 * - 邮箱 / 微信：CustomerExtra 那两列（外贸查重比的就是它们）+ 联系人的邮箱 / 微信，去空格、不分大小写
 * - 旺旺 ID：EntContactNumber（migrations/054）
 * 本机都没撞的，手机号 / 邮箱 / 微信再问一下团队版服务端（问同事，没开团队版当没撞），和原来的查重一样。
 *
 * B8 的七条提示做了四条：✅首次录入、⛔公海待捞、📒我的通讯录已有、⛔号码重复（可与 X 沟通核实）。
 * 没做：「❎首次录入，但与 X 存在重复」（要按客户名查重，清单 A8 定了不做）；「📁请上传二维码图片」
 * 「🔀请选择号码类型」两条是格式那一半的（contact-format.ts）
 */
import type { Prisma } from "@/generated/prisma";
import type { prisma } from "@/lib/prisma";
import { 号键 } from "@/lib/phone";
import { 号键SQL, 同号条件, 分机留存起 } from "@/lib/phone-dedupe";
import { 同邮箱条件, 同微信条件 } from "@/lib/email-dedupe";
import { 看全部, 看得到, type 谁 } from "@/lib/team-scope";
import { 问同事 } from "@/lib/sync/dedupe-client";
import { 查重提示, type 号码类型 } from "./contact-format";

/** EntContactNumber.kind：号码类型 → 库里的写法。只有现有列里没有的类型才有 */
export const 号码库类型 = { 旺旺ID: "wangwang" } as const satisfies Partial<Record<号码类型, string>>;

type 库 = Prisma.TransactionClient | typeof prisma;

/** 联系人表里号码对得上的客户 id。联系人的电话存的是人填的原样，按号键比；国内号顺带认带 86 的写法 */
async function 联系人里的(db: 库, 类型: "手机号" | "邮箱" | "微信", 键: string): Promise<string[]> {
  if (类型 === "手机号") {
    const 键们 = /^\d{11}$/.test(键) ? [键, `86${键}`] : [键];
    const 行 = await db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT DISTINCT "customerId" AS id FROM "Contact" WHERE ${号键SQL('"phone"')} IN (${键们.map(() => "?").join(", ")})`, ...键们);
    return 行.map((r) => r.id);
  }
  const 列 = 类型 === "邮箱" ? "email" : "wechat";
  const 行 = await db.$queryRawUnsafe<{ id: string }[]>(`SELECT DISTINCT "customerId" AS id FROM "Contact" WHERE lower(trim("${列}")) = ?`, 键);
  return 行.map((r) => r.id);
}

/**
 * 号码撞到的客户 id（全公司，不分谁名下）。值 / 键 是 验号码 规整过的。除了 = 编辑时排除自己（现在只有新建用）。
 * db 传事务就在事务里查（查完再写）
 */
export async function 全公司查号(db: 库, 类型: 号码类型, 值: string, 键: string, 除了?: string): Promise<string[]> {
  const 客户条件 = async (): Promise<Prisma.CustomerWhereInput | null> => {
    if (类型 === "手机号") {
      // 国内号顺带认库里存成「+86 139…」的老写法（saveCustomer 存的是 11 位，导入 / 老数据不一定）
      const 起 = await 分机留存起();
      const 条件们 = [await 同号条件(db, 值, 起), ...(/^\d{11}$/.test(值) ? [await 同号条件(db, `86${值}`, 起)] : [])];
      return 条件们.length > 1 ? { OR: 条件们 } : 条件们[0];
    }
    if (类型 === "邮箱") return 同邮箱条件(db, 值);
    if (类型 === "微信") return 同微信条件(db, 值);
    return null;
  };
  const ids = new Set<string>();
  const 条件 = await 客户条件();
  if (条件) for (const c of await 看全部(async () => db.customer.findMany({ where: 条件, select: { id: true } }))) ids.add(c.id);
  if (类型 === "手机号" || 类型 === "邮箱" || 类型 === "微信") for (const id of await 联系人里的(db, 类型, 类型 === "手机号" ? 号键(值) : 键)) ids.add(id);
  if (类型 === "旺旺ID") {
    for (const r of await db.entContactNumber.findMany({ where: { kind: 号码库类型.旺旺ID, numberKey: 键 }, select: { customerId: true } })) ids.add(r.customerId);
  }
  if (除了) ids.delete(除了);
  return [...ids];
}

/** 给人看的撞到的那位：和 checkDuplicate 的 DuplicateHit 一个样子 */
export type 撞到的人 = { id: string | null; name: string | null; school: string | null; salesOwnerName: string; createdAt: string | null };

export type 查号结论 =
  | { 状态: "首次录入"; 提示: string; 撞: null }
  | { 状态: "公海待捞" | "我的通讯录已有" | "重复"; 提示: string; 撞: 撞到的人 };

/**
 * 撞到的 id → 提示。好几位都撞的挑一位说：我名下的优先（📒），其次在公海的（⛔公海待捞），再其次同事的。
 * 我 = 当前登录的人（「我的通讯录」只算本人名下，下属的也算同事的）；读的我 = 看得到的范围（团队版 / 企业版的限定）
 */
export async function 撞号结论(db: 库, ids: string[], 我: string, 读的我: 谁 | null): Promise<查号结论> {
  if (!ids.length) return { 状态: "首次录入", 提示: 查重提示.首次录入, 撞: null };
  const 们 = await 看全部(async () => db.customer.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, school: true, createdAt: true, salesOwnerId: true, channelOwnerId: true, pool: { select: { customerId: true } }, salesOwner: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  }));
  const 挑 = 们.find((c) => c.salesOwnerId === 我) ?? 们.find((c) => c.pool) ?? 们[0];
  if (!挑) return { 状态: "首次录入", 提示: 查重提示.首次录入, 撞: null };
  const 看得见 = 看得到(挑, 读的我);
  const 同事 = 挑.salesOwner?.name ?? "同事";
  const 撞: 撞到的人 = {
    id: 看得见 ? 挑.id : null,
    name: 看得见 ? 挑.name : null,
    school: 看得见 ? 挑.school : null,
    salesOwnerName: 同事,
    createdAt: 看得见 ? 挑.createdAt.toISOString() : null,
  };
  if (挑.salesOwnerId === 我 && !挑.pool) return { 状态: "我的通讯录已有", 提示: 查重提示.我的通讯录已有, 撞 };
  if (挑.pool) return { 状态: "公海待捞", 提示: 查重提示.公海待捞, 撞 };
  return { 状态: "重复", 提示: 查重提示.重复(同事), 撞 };
}

/** 本机没撞的，再问一下团队版服务端（同 checkDuplicate）。旺旺 ID 服务端没有这一种，不问 */
export async function 问同事撞没撞(类型: 号码类型, 值: string): Promise<查号结论 | null> {
  const 种 = 类型 === "手机号" ? "phone" : 类型 === "邮箱" ? "email" : 类型 === "微信" ? "wechat" : null;
  if (!种) return null;
  const 撞 = await 问同事(种, 值);
  return 撞 ? { 状态: "重复", 提示: 查重提示.重复(撞.同事), 撞: { id: null, name: null, school: null, salesOwnerName: 撞.同事, createdAt: null } } : null;
}

/** 查重整套：全公司本机比一遍，没撞再问团队版服务端。向导的「查重」按钮和 saveCustomer 保存前都走这一个 */
export async function 企业号码查重(db: 库, 号: { 类型: 号码类型; 值: string; 键: string }, 我: string, 读的我: 谁 | null): Promise<查号结论> {
  const ids = await 全公司查号(db, 号.类型, 号.值, 号.键);
  if (ids.length) return 撞号结论(db, ids, 我, 读的我);
  return (await 问同事撞没撞(号.类型, 号.值)) ?? { 状态: "首次录入", 提示: 查重提示.首次录入, 撞: null };
}
