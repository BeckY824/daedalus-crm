"use server";

/**
 * 团队版项目模式 1a 的写（2026-10-23，D-31）。开关关着时每个动作都直接拦，一行不写。
 * 规矩在 lib/project/nodes.ts、读写在 lib/project/db.ts、建档向导在 lib/project/wizard.ts，这里只管登录、开关、操作日志和刷新。
 */
import { revalidatePath } from "next/cache";
import { prisma, defaultClient } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { 不在了 } from "@/lib/not-there";
import { getBusiness } from "@/lib/business";
import { 读的我 } from "@/lib/team-scope";
import { 验号码 } from "@/lib/enterprise/contact-format";
import { 验联系人号码, 企业号码查重, 全公司查号, 撞号结论, 记号码, 联系人号码撞了 } from "@/lib/enterprise/contact-dedupe";
import { 登记接着建 } from "@/lib/project/hook";
import { 规整向导, 向导接着建, type 建好的, type 向导联系人, type 向导项目, type 向导跟进 } from "@/lib/project/wizard";
import { 改节点, 勾交付, 加角色, 改角色, 加异常类别, 改异常类别, 删项目, 交付项们, 改项目, 加组员, 回邀请, 换组员角色, 移出组员, 放回公海, 领取公海项目, 超上限, 记项目沟通, 超时预览, 公海超时收回, type 交付项 } from "@/lib/project/db";
import { 合上改动, type 规则改动 } from "@/lib/project/org-rules";
import { 读组织规则, 生效组织规则, 存组织规则 } from "@/lib/project/org-rules-store";
import { 企业版 } from "@/lib/enterprise/switch";
import { 看全部 } from "@/lib/team-scope";
import { 挡改设置, type 设置项名 } from "@/lib/enterprise/edit-perm";
import { 记这个项目的自动推进, 客户存了推项目 } from "@/lib/project/auto-advance";
import { 读团队 } from "@/lib/sync/client";
import { 要写原因, type 位置 } from "@/lib/project/nodes";
import { saveCustomer, type CustomerInput } from "../customers/actions";

const 没开 = { ok: false as const, error: "项目模式没开：请老板在「设置 → 业务配置」里打开" };

async function 开着(): Promise<boolean> {
  return (await getBusiness()).projectMode === true;
}

function 刷新项目(projectId?: string, customerId?: string) {
  revalidatePath("/projects");
  if (projectId) revalidatePath(`/projects/${projectId}`);
  if (customerId) revalidatePath(`/customers/${customerId}`);
}

export type 建档向导输入 = { 客户: CustomerInput; 联系人: 向导联系人; 项目: 向导项目; 跟进: 向导跟进 };

/**
 * 建档向导的最后一步：客户、主要联系人、项目、首条跟进一笔建好。
 * 客户查重撞了、哪一步写失败了，整笔都不留；中途关掉向导时根本没走到这里
 */
export async function 建档向导(input: 建档向导输入) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    if (!input || typeof input !== "object" || !input.客户 || typeof input.客户 !== "object") return { ok: false as const, error: "建档信息不完整，请从头再走一遍" };
    // 开了超时回收：项目建在线索阶段，首条跟进也得填下一步时间
    const 规则 = await 生效组织规则();
    // 下一步时间只在开了超时回收时有这格（不是企业版一律没开）：没开时老草稿里留着的也不认、不写，和原来一样
    const 要下一步 = 规则.超时回收.开;
    const 好 = 规整向导(me, 要下一步 || !input.跟进 ? input : { ...input, 跟进: { ...input.跟进, 下一步时间: null } }, new Date(), 要下一步);
    if ("error" in 好) return { ok: false as const, error: 好.error };
    const 负责人 = await prisma.user.findUnique({ where: { id: 好.项目.ownerId }, select: { name: true, active: true } });
    if (!负责人?.active) return { ok: false as const, error: "项目负责人不存在或已停用，请选一位在职成员" };
    // 负责人选了别人 = 指派，开了持有上限的要算；自己建给自己不拦（lib/project/db.ts 超上限）
    if (好.项目.ownerId !== me.id) {
      const 超 = await 超上限(prisma, 规则, 好.项目.ownerId, { phase: "线索", result: null });
      if (超) return { ok: false as const, error: 超 };
    }

    /*
      企业版：联系人那一步的电话 / 邮箱 / 微信也按类型验格式、全公司查重（QA #3「邮箱不去重」），
      和第一步选了号码类型的那个号同一套；事务里再比一次（查完再写），建好后记进联系方式子表、挂在这位联系人上。
      开关关着不走：联系人的号和原来一样不查
    */
    const 企 = 企业版();
    const 第一步 = 企 && input.客户.企业号码 ? 验号码(input.客户.企业号码.类型, input.客户.企业号码.值) : null;
    const 联号 = 企 ? 验联系人号码(好.联系人, 第一步?.ok ? 第一步 : null) : [];
    if ("error" in 联号) return { ok: false as const, error: 联号.error };
    const 要查 = 联号.filter((号) => !号.同第一步);
    for (const 号 of 要查) {
      const 结论 = await 企业号码查重(prisma, 号, me.id, await 读的我(defaultClient));
      if (结论.状态 !== "首次录入") return { ok: false as const, error: `${号.格}：${结论.提示}` };
    }

    const 建了: Partial<建好的> = {};
    const 向导 = 向导接着建(me, 好, 建了);
    const 接着 = !企 ? 向导 : 登记接着建(async (tx, customerId) => {
      for (const 号 of 要查) {
        const ids = await 全公司查号(tx, 号.类型, 号.值, 号.键, customerId);
        if (ids.length) throw new 联系人号码撞了(ids, 号.格);
      }
      await 向导(tx, customerId);
      for (const 号 of 联号) await 记号码(tx, customerId, 建了.contactId ?? null, 号);
    });
    let r: Awaited<ReturnType<typeof saveCustomer>>;
    try {
      r = await saveCustomer({ ...input.客户, id: undefined, updatedAt: null, base: null }, 接着);
    } catch (e) {
      if (!(e instanceof 联系人号码撞了)) throw e;
      return { ok: false as const, error: `${e.格}：${(await 撞号结论(prisma, e.ids, me.id, await 读的我(defaultClient))).提示}` };
    }
    if (!r.ok) return r;
    await recordAudit({
      user: me, action: "create", entity: "Project", entityId: 建了.projectId,
      summary: `建档：新建项目「${好.项目.name}」（负责人 ${负责人.name}），连同主要联系人「${好.联系人.name}」和首条跟进`,
      detail: { 项目: 好.项目.name, 负责人: 负责人.name, 金额: 好.项目.amount, 币种: 好.项目.currency, 联系人: 好.联系人.name },
    });
    // 首条跟进记在潜客培育上：配的必填建档时就齐了的，接着往前推
    await 客户存了推项目(me, r.id);
    刷新项目(建了.projectId, r.id);
    revalidatePath("/follow-ups");
    return { ok: true as const, customerId: r.id, projectId: 建了.projectId! };
  } catch (e) { return 不在了(e); }
}

/** 改节点。进异常状态时带上异常类别（必选）和备注（可空）；企业版点线索流失、丢单时 备注 = 原因（必填） */
export async function 改项目节点(projectId: string, 到: 位置, 异常?: { categoryId?: string | null; 备注?: string | null } | null) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    if (!到 || typeof 到 !== "object") return { ok: false as const, error: "要改到哪个节点？" };
    const 异 = 异常 && typeof 异常 === "object" ? { categoryId: 异常.categoryId ?? null, 备注: 异常.备注 ?? null } : undefined;
    const r = await 改节点(me, projectId, 到, 异);
    if (r.ok && r.变了) {
      const p = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true, customerId: true, exceptionCategory: { select: { name: true } } } });
      const 类别 = 到.result === "异常状态" ? p?.exceptionCategory?.name ?? null : null;
      await recordAudit({
        user: me, action: "update", entity: "Project", entityId: projectId,
        summary: `项目「${p?.name ?? ""}」改到 ${到.phase}·${到.node}${到.result ? `（${到.result}${类别 ? `：${类别}` : ""}）` : ""}`,
        detail: { 阶段: 到.phase, 节点: 到.node, 结局: 到.result ?? null, 异常类别: 类别, 备注: 类别 || (企业版() && 要写原因(到.result)) ? 异?.备注?.trim() || null : null },
      });
      await 记这个项目的自动推进(me, projectId, r.自动推到);
      刷新项目(projectId, p?.customerId);
    }
    return r;
  } catch (e) { return 不在了(e); }
}

/** 负责人把项目放回项目公海（线索 / 商机阶段） */
export async function 放回项目公海(projectId: string) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    const r = await 放回公海(me, projectId);
    if (r.ok) {
      const p = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true, customerId: true } });
      await recordAudit({ user: me, action: "update", entity: "Project", entityId: projectId, summary: `把项目「${p?.name ?? ""}」放回项目公海` });
      刷新项目(projectId, p?.customerId);
    }
    return r;
  } catch (e) { return 不在了(e); }
}

/** 从项目公海领取：领了就是负责人 */
export async function 领取项目(projectId: string) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    const r = await 领取公海项目(me, projectId);
    if (r.ok) {
      const p = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true, customerId: true } });
      await recordAudit({ user: me, action: "update", entity: "Project", entityId: projectId, summary: `从项目公海领取项目「${p?.name ?? ""}」` });
      刷新项目(projectId, p?.customerId);
    }
    return r;
  } catch (e) { return 不在了(e); }
}

export async function 勾项目交付(projectId: string, 项: 交付项, 勾: boolean) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    const r = await 勾交付(me, projectId, 项, 勾 === true);
    if (r.ok && r.变了) {
      const p = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true, customerId: true } });
      await recordAudit({
        user: me, action: "update", entity: "Project", entityId: projectId,
        summary: `项目「${p?.name ?? ""}」${勾 ? "勾上" : "取消"}「${交付项们[项]}」`,
      });
      await 记这个项目的自动推进(me, projectId, r.自动推到);
      刷新项目(projectId, p?.customerId);
    }
    return r;
  } catch (e) { return 不在了(e); }
}

export async function 删除项目(projectId: string) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    const r = await 删项目(me, projectId);
    if (r.ok) {
      await recordAudit({ user: me, action: "delete", entity: "Project", entityId: projectId, summary: `删除项目「${r.name}」` });
      刷新项目(undefined, r.customerId);
    }
    return r.ok ? { ok: true as const } : r;
  } catch (e) { return 不在了(e); }
}

export async function 加组员角色(name: string) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    const r = await 加角色(me, name);
    if (r.ok) {
      await recordAudit({ user: me, action: "create", entity: "ProjectRole", entityId: r.id, summary: `加了项目组员角色「${String(name).trim()}」` });
      revalidatePath("/settings");
    }
    return r;
  } catch (e) { return 不在了(e); }
}

export async function 改组员角色(id: string, patch: { name?: string; active?: boolean }) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    const 原 = await prisma.projectRole.findUnique({ where: { id: String(id ?? "") }, select: { name: true } });
    const r = await 改角色(me, id, patch ?? {});
    if (r.ok) {
      const 做了 = patch.active === false ? "停用" : patch.active === true ? "启用" : "改名";
      await recordAudit({
        user: me, action: "update", entity: "ProjectRole", entityId: id,
        summary: `${做了}项目组员角色「${原?.name ?? ""}」${patch.name ? ` → 「${String(patch.name).trim()}」` : ""}`,
      });
      revalidatePath("/settings");
    }
    return r;
  } catch (e) { return 不在了(e); }
}

export async function 加项目异常类别(name: string) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    const r = await 加异常类别(me, name);
    if (r.ok) {
      await recordAudit({ user: me, action: "create", entity: "ProjectExceptionCategory", entityId: r.id, summary: `加了项目异常类别「${String(name).trim()}」` });
      revalidatePath("/settings");
    }
    return r;
  } catch (e) { return 不在了(e); }
}

export async function 改项目异常类别(id: string, patch: { name?: string; active?: boolean }) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    const 原 = await prisma.projectExceptionCategory.findUnique({ where: { id: String(id ?? "") }, select: { name: true } });
    const r = await 改异常类别(me, id, patch ?? {});
    if (r.ok) {
      const 做了 = patch.active === false ? "停用" : patch.active === true ? "启用" : "改名";
      await recordAudit({
        user: me, action: "update", entity: "ProjectExceptionCategory", entityId: id,
        summary: `${做了}项目异常类别「${原?.name ?? ""}」${patch.name ? ` → 「${String(patch.name).trim()}」` : ""}`,
      });
      revalidatePath("/settings");
    }
    return r;
  } catch (e) { return 不在了(e); }
}

const 项目字段名: Record<string, string> = { name: "名称", ownerId: "负责人", amount: "金额", currency: "币种", remark: "备注", contactId: "主联系人" };

/** 编辑项目：名称、负责人、金额、币种、备注、主联系人 */
export async function 编辑项目(projectId: string, patch: 向导项目 & { contactId?: string | null }) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    const r = await 改项目(me, projectId, patch);
    if (r.ok && r.变了?.length) {
      const p = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true, customerId: true } });
      await recordAudit({
        user: me, action: "update", entity: "Project", entityId: projectId,
        summary: `编辑项目「${p?.name ?? ""}」：改了${r.变了.map((k) => 项目字段名[k] ?? k).join("、")}`,
      });
      await 记这个项目的自动推进(me, projectId, r.自动推到);
      刷新项目(projectId, p?.customerId);
    }
    return r.ok ? { ok: true as const, ...(r.自动推到 ? { 自动推到: r.自动推到 } : {}) } : r;
  } catch (e) { return 不在了(e); }
}

async function 组员说法(projectId: string, userId: string) {
  const [p, u] = await Promise.all([
    // 回邀请的人同意前看不到项目：这里只取名字写日志
    看全部(() => prisma.project.findUnique({ where: { id: projectId }, select: { name: true } })),
    prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
  ]);
  return `项目「${p?.name ?? ""}」的项目组：${u?.name ?? "已不在的成员"}`;
}

export async function 加项目组员(projectId: string, userId: string, roleId?: string | null) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    const r = await 加组员(me, projectId, userId, roleId);
    if (r.ok) {
      const 邀请 = 企业版() && userId !== me.id;
      await recordAudit({ user: me, action: "create", entity: "ProjectMember", entityId: projectId, summary: `${邀请 ? "邀请进" : "加进"}${await 组员说法(projectId, userId)}` });
      刷新项目(projectId);
    }
    return r;
  } catch (e) { return 不在了(e); }
}

/** 企业版：被邀请的人点同意 / 拒绝 */
export async function 回项目邀请(memberId: string, 同意: boolean) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    if (!企业版()) return { ok: false as const, error: "项目组邀请是企业版的功能" };
    const r = await 回邀请(me, memberId, 同意 === true);
    if (r.ok && r.projectId) {
      await recordAudit({ user: me, action: "update", entity: "ProjectMember", entityId: r.projectId, summary: `${同意 === true ? "同意加入" : "拒绝加入"}${await 组员说法(r.projectId, me.id)}` });
      刷新项目(r.projectId);
    }
    return r.ok ? { ok: true as const } : r;
  } catch (e) { return 不在了(e); }
}

export async function 换项目组员角色(memberId: string, roleId: string | null) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    const m = await prisma.projectMember.findUnique({ where: { id: String(memberId ?? "") }, select: { projectId: true, userId: true, roleId: true } });
    const r = await 换组员角色(me, memberId, roleId);
    if (r.ok && m && (roleId || null) !== m.roleId) {
      const 角色 = roleId ? (await prisma.projectRole.findUnique({ where: { id: roleId }, select: { name: true } }))?.name : null;
      await recordAudit({ user: me, action: "update", entity: "ProjectMember", entityId: m.projectId, summary: `${await 组员说法(m.projectId, m.userId)} 角色改成「${角色 ?? "不填"}」` });
      刷新项目(m.projectId);
    }
    return r;
  } catch (e) { return 不在了(e); }
}

export async function 移出项目组员(memberId: string) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    const m = await prisma.projectMember.findUnique({ where: { id: String(memberId ?? "") }, select: { projectId: true, userId: true } });
    const r = await 移出组员(me, memberId);
    if (r.ok && m) {
      await recordAudit({ user: me, action: "delete", entity: "ProjectMember", entityId: m.projectId, summary: `移出${await 组员说法(m.projectId, m.userId)}` });
      刷新项目(m.projectId);
    }
    return r;
  } catch (e) { return 不在了(e); }
}

/**
 * 这次改动碰到的每一块都得能改：公海 = 持有上限，超时回收 = 节点时限，节点推进 = 必填字段
 * （「后台设置谁能改」，lib/enterprise/edit-perm-table.ts；老板总能改）
 */
async function 挡组织规则(me: { id: string; role: string }, 改: 规则改动): Promise<string | null> {
  const 块: [keyof 规则改动, 设置项名, string][] = [["公海", "持有上限", "项目持有上限"], ["超时回收", "节点时限", "各节点时限"], ["节点推进", "必填字段", "节点必填字段"]];
  for (const [k, 项, 叫法] of 块) {
    if (改?.[k] === undefined) continue;
    const 挡 = await 挡改设置(me, 项);
    if (挡) return `${叫法}${挡}`;
  }
  return null;
}

/** 企业版组织规则（持有上限等）：不是企业版改不了；谁能改见 挡组织规则，每条默认关（lib/project/org-rules.ts） */
export async function 改组织规则(改: 规则改动) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    if (!企业版()) return { ok: false as const, error: "组织规则是企业版的功能" };
    const 挡 = await 挡组织规则(me, 改);
    if (挡) return { ok: false as const, error: 挡 };
    const 新 = 合上改动(await 读组织规则(), 改);
    if ("error" in 新) return { ok: false as const, error: 新.error };
    await 存组织规则(新);
    const g = 新.公海, t = 新.超时回收;
    const 推 = 新.节点推进;
    const 说 = 改.节点推进 !== undefined
      ? 推.开 ? `组织规则：节点推进开，${Object.keys(推.必填).length} 个节点配了必填` : "组织规则：节点推进关"
      : 改.超时回收 !== undefined
      ? t.开 ? `组织规则：超时回收开，设了 ${Object.keys(t.节点天数).length} 个节点的处理时长` : "组织规则：超时回收关"
      : g.持有上限开 ? `组织规则：项目持有上限开，默认 ${g.默认上限} 个，单独设了 ${Object.keys(g.每人上限).length} 人` : "组织规则：项目持有上限关";
    await recordAudit({ user: me, action: "update", entity: "Setting", entityId: "orgRules", summary: 说, detail: 新 });
    // 改了时长当场按新的扫一遍（老板保存前已经看过会回收几个）
    const 收回 = 改.超时回收 !== undefined ? await 公海超时收回(me) : 0;
    revalidatePath("/settings");
    if (收回) revalidatePath("/projects");
    return { ok: true as const, 收回 };
  } catch (e) { return 不在了(e); }
}

/** 老板保存超时回收设置前先看：按改完的规则，现在会有几个项目回到公海 */
export async function 预览超时回收(改: 规则改动) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    if (!企业版()) return { ok: false as const, error: "组织规则是企业版的功能" };
    const 挡 = await 挡组织规则(me, 改);
    if (挡) return { ok: false as const, error: 挡 };
    const 新 = 合上改动(await 读组织规则(), 改);
    if ("error" in 新) return { ok: false as const, error: 新.error };
    return { ok: true as const, 个数: await 超时预览(新), 团队: !!读团队() };
  } catch (e) { return 不在了(e); }
}

/** 在项目上记一条沟通（项目详情「记一条」）。开了超时回收的线索 / 商机阶段要带下一步时间 */
export async function 记项目沟通Action(projectId: string, input: 向导跟进) {
  try {
    const me = await requireUser();
    if (!(await 开着())) return 没开;
    if (!企业版()) return { ok: false as const, error: "在项目上记沟通是企业版的功能，请去客户页记" };
    const r = await 记项目沟通(me, projectId, input);
    if (r.ok) {
      const p = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true, customerId: true } });
      await recordAudit({
        user: me, action: "create", entity: "FollowUp", entityId: r.followUpId,
        summary: `在项目「${p?.name ?? ""}」上记了一条沟通`,
      });
      await 记这个项目的自动推进(me, projectId, r.自动推到);
      刷新项目(projectId, p?.customerId);
      revalidatePath("/follow-ups");
    }
    return r.ok ? { ok: true as const, ...(r.自动推到 ? { 自动推到: r.自动推到 } : {}) } : r;
  } catch (e) { return 不在了(e); }
}
