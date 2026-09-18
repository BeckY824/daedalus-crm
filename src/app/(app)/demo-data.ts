"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { multiTenant } from "@/lib/tenant/context";
import { recordAudit } from "@/lib/audit";
import { 灌演示数据 } from "@/lib/shared-ws/dataset";
import { 本地模式 } from "@/lib/desktop/cloud";

/**
 * 「灌一套演示数据」——给自己架一套网页版的团队看这东西装满之后长什么样。
 *
 * 装完是一个空库：列表全空、看板全是 0、首页那个「问一位客户」的提示框对着空库无从下手。
 * 托管版那个共享工作区的演示数据是脚本灌的（scripts/seed-shared.ts），自部署没有，这里补上。
 * 数据集是同一份 `src/lib/shared-ws/dataset.ts`，不另造一套。
 *
 * **它写进用户真实的库，所以护栏比功能本身重要：**
 *   - 托管版一律不给。那边是多租户，共享工作区的重置走 seed-shared.ts，不该有个按钮能从界面上重灌
 *   - **桌面端也不给**（2026-09-18）。桌面端是一个人自己的库，装完就该录自己的第一位客户；
 *     一屏之内摆一颗「灌一套假数据」只会让人分不清哪些是真的。网页版留着——那边常常是
 *     一个团队先拿它看看长什么样，再决定要不要用
 *   - 只有管理员能点
 *   - **只往空库里灌**。库里已经有任何业务数据就拒绝——宁可让人手动删，也不能有任何一条路径
 *     会覆盖掉真实客户
 *   - 灌完在 Setting 里记一笔，界面据此把「清除」显示出来
 *
 * 清除会删掉**全部**业务数据，不只是演示的那些——灌完之后自己录的也一起没。
 * 这一点必须在按钮的确认框里写清楚，不能只说「清除演示数据」。
 */

const 标记 = "demoDataSeededAt";

export type 演示数据状态 = {
  /** 这个部署形态允不允许演示数据这件事（托管版不允许）。清除这条路由它管 */
  可用: boolean;
  /** 能不能**灌**。桌面端只能清、不能灌：已经灌过的老用户还得有路把它清掉 */
  可灌: boolean;
  /** 管理员才能动 */
  有权限: boolean;
  /** 库里一条业务数据都没有 */
  空库: boolean;
  /** 灌过（Setting 里有标记） */
  已灌: boolean;
};

async function 业务数据条数() {
  const [customers, leads, channels, opportunities] = await Promise.all([
    prisma.customer.count(),
    prisma.lead.count(),
    prisma.channel.count(),
    prisma.opportunity.count(),
  ]);
  return customers + leads + channels + opportunities;
}

export async function 查演示数据状态(): Promise<演示数据状态> {
  const me = await requireUser();
  const 可用 = !multiTenant();
  if (!可用) return { 可用: false, 可灌: false, 有权限: false, 空库: false, 已灌: false };
  const [条数, 记号] = await Promise.all([
    业务数据条数(),
    prisma.setting.findUnique({ where: { key: 标记 }, select: { value: true } }),
  ]);
  return { 可用: true, 可灌: !本地模式(), 有权限: me.role === "ADMIN", 空库: 条数 === 0, 已灌: !!记号 };
}

export async function 灌一套演示数据(): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireUser();
  if (multiTenant()) return { ok: false, error: "托管版不支持从界面灌演示数据" };
  if (本地模式()) return { ok: false, error: "桌面端不提供演示数据" };
  if (me.role !== "ADMIN") return { ok: false, error: "只有管理员能灌演示数据" };
  // 空库才灌。这条是这个功能唯一的安全保证，别为了「方便」放宽
  if ((await 业务数据条数()) > 0) return { ok: false, error: "库里已经有数据了。演示数据只能灌进一个全空的库——要重来请先手动清空" };

  await 灌演示数据(prisma, me.id);
  await prisma.setting.upsert({
    where: { key: 标记 },
    create: { key: 标记, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });
  await recordAudit({ user: me, action: "create", entity: "Setting", entityId: 标记, summary: "灌入一套演示数据" });
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function 清除演示数据(): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireUser();
  if (multiTenant()) return { ok: false, error: "托管版不支持从界面清除数据" };
  if (me.role !== "ADMIN") return { ok: false, error: "只有管理员能清除数据" };
  const 记号 = await prisma.setting.findUnique({ where: { key: 标记 }, select: { value: true } });
  if (!记号) return { ok: false, error: "这个库里没有灌过演示数据" };

  // 顺序按外键依赖来，最后才动 customer（它自引用推荐链，要先把引用解开）
  await prisma.auditLog.deleteMany();
  await prisma.task.deleteMany();
  await prisma.followPlan.deleteMany();
  await prisma.followUpSource.deleteMany();
  await prisma.followUp.deleteMany();
  await prisma.contract.deleteMany();
  await prisma.opportunity.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.customer.updateMany({ data: { referrerCustomerId: null, attributionCustomerId: null } });
  await prisma.customer.deleteMany();
  await prisma.channel.deleteMany();
  // 演示数据造的那几个同事。只删这一批：真实同事的邮箱不会长这样
  await prisma.user.deleteMany({ where: { email: { endsWith: "@qiming.local" } } });
  await prisma.setting.delete({ where: { key: 标记 } });

  revalidatePath("/", "layout");
  return { ok: true };
}
