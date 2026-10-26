"use server";
/**
 * 企业版「组织架构」设置页的写操作（2026-10-24）：部门增改删、给人定部门 / 角色 / 业务线 / 上级。
 *
 * 只在企业版开着时可用；老板（账号管理员）和业务角色是总管理员的人能改。
 * 总管理员级别的角色（总管理 / 管理员）只有老板能给、能动，免得总管理员互相把对方降级。
 * 规则检查都在 lib/enterprise/org.ts 的纯函数里，这里只负责读库、写库、留痕。
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser, type SessionUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { 不在了 } from "@/lib/not-there";
import { setSetting } from "@/lib/settings";
import { 企业版 } from "@/lib/enterprise/switch";
import { 规则, type 规则名 } from "@/lib/enterprise/rules";
import { 忘掉企业版范围 } from "@/lib/enterprise/visibility";
import { 读组织, 建组织, 管理员类别of, 部门挪动问题, 上级设置问题, type 组织部门 } from "@/lib/enterprise/org";
import { 是业务角色, 角色名, type 业务角色 } from "@/lib/sync/dept-policy";
import { 规整字段配置, 字段权限key } from "@/lib/enterprise/field-perm";
import { 挡改设置, 规整改权限, 改权限key, 设置项, 设置项们, 谁能改, type 设置项名 } from "@/lib/enterprise/edit-perm";

type 结果 = { ok: true } | { ok: false; error: string };

/** 组织、规则一改，谁看得到谁的客户就变了：页面和限定层的缓存一起清 */
function 改完了() {
  忘掉企业版范围();
  revalidatePath("/settings");
}

const 总管级 = (r: string | null | undefined) => r === "director" || r === "admin";

/** 能改组织架构的人；不能改返回 null */
async function 能改的人() {
  if (!企业版()) return null;
  const me = await requireUser();
  const { 当前是共享区 } = await import("@/lib/shared-ws/current");
  if (await 当前是共享区()) return null;
  if (me.role === "ADMIN") return { me, 是老板: true };
  return 管理员类别of(await 读组织(), me.id) === "总管理员" ? { me, 是老板: false } : null;
}
const 不能改: 结果 = { ok: false, error: "只有老板或总管理员能改组织架构" };

async function 全部部门(): Promise<Map<string, 组织部门>> {
  const ds = await prisma.entDept.findMany({ select: { id: true, name: true, parentId: true, sort: true } });
  return new Map(ds.map((d) => [d.id, d]));
}

function 名字问题(部门: ReadonlyMap<string, 组织部门>, name: string, parentId: string | null, 自己?: string): string | null {
  if (!name) return "部门名不能为空";
  if (name.length > 40) return "部门名最多 40 个字";
  for (const d of 部门.values()) if (d.id !== 自己 && (d.parentId ?? null) === parentId && d.name === name) return "同一级已经有这个部门了";
  return null;
}

export async function 建部门(名: string, parentId: string | null): Promise<结果> {
  const who = await 能改的人();
  if (!who) return 不能改;
  try {
    const name = 名.trim();
    const 部门 = await 全部部门();
    const 问题 = 名字问题(部门, name, parentId) ?? 部门挪动问题(部门, null, parentId);
    if (问题) return { ok: false, error: 问题 };
    const sort = [...部门.values()].filter((d) => (d.parentId ?? null) === parentId).reduce((m, d) => Math.max(m, d.sort + 1), 0);
    const d = await prisma.entDept.create({ data: { name, parentId, sort } });
    await recordAudit({ user: who.me, action: "create", entity: "EntDept", entityId: d.id, summary: `新建部门「${name}」` });
    改完了();
    return { ok: true };
  } catch (e) {
    return 不在了(e);
  }
}

export async function 改部门(id: string, 改: { name: string; parentId: string | null }): Promise<结果> {
  const who = await 能改的人();
  if (!who) return 不能改;
  try {
    const name = 改.name.trim();
    const 部门 = await 全部部门();
    const 原 = 部门.get(id);
    if (!原) return { ok: false, error: "这个部门已经不在了，刷新看看" };
    const 问题 = 名字问题(部门, name, 改.parentId, id) ?? 部门挪动问题(部门, id, 改.parentId);
    if (问题) return { ok: false, error: 问题 };
    await prisma.entDept.update({ where: { id }, data: { name, parentId: 改.parentId } });
    const 说 = [原.name !== name && `改名为「${name}」`, (原.parentId ?? null) !== 改.parentId && `挪到「${改.parentId ? 部门.get(改.parentId)!.name : "最上层"}」底下`].filter(Boolean).join("，");
    await recordAudit({ user: who.me, action: "update", entity: "EntDept", entityId: id, summary: `部门「${原.name}」${说 || "没有变化"}` });
    改完了();
    return { ok: true };
  } catch (e) {
    return 不在了(e);
  }
}

export async function 删部门(id: string): Promise<结果> {
  const who = await 能改的人();
  if (!who) return 不能改;
  try {
    const 部门 = await 全部部门();
    const 原 = 部门.get(id);
    if (!原) return { ok: false, error: "这个部门已经不在了，刷新看看" };
    if ([...部门.values()].some((d) => d.parentId === id)) return { ok: false, error: "先删掉或挪走它下面的部门" };
    const 人数 = await prisma.entMember.count({ where: { deptId: id } });
    if (人数) return { ok: false, error: `还有 ${人数} 个人在这个部门，先把他们换到别的部门` };
    await prisma.entDept.delete({ where: { id } });
    await recordAudit({ user: who.me, action: "delete", entity: "EntDept", entityId: id, summary: `删除部门「${原.name}」` });
    改完了();
    return { ok: true };
  } catch (e) {
    return 不在了(e);
  }
}

export type 成员改动 = {
  deptId?: string | null;
  bizRole?: string;
  line?: string | null;
  managerId?: string | null;
  dottedManagerId?: string | null;
};

const 可改字段 = ["deptId", "bizRole", "line", "managerId", "dottedManagerId"] as const;

export async function 设成员(userId: string, 传来的: 成员改动): Promise<结果> {
  const who = await 能改的人();
  if (!who) return 不能改;
  // 接口能直调：只收这几个字段，别的、值是 undefined 的都丢掉
  const 改: 成员改动 = Object.fromEntries(可改字段.filter((k) => 传来的?.[k] !== undefined).map((k) => [k, 传来的[k]]));
  if (!Object.keys(改).length) return { ok: true };
  try {
    const [users, members, depts] = await Promise.all([
      prisma.user.findMany({ select: { id: true, name: true, role: true, active: true } }),
      prisma.entMember.findMany(),
      prisma.entDept.findMany({ select: { id: true, name: true, parentId: true, sort: true } }),
    ]);
    const 人 = users.find((u) => u.id === userId);
    if (!人 || !人.active) return { ok: false, error: "这个人不在职" };
    if (改.bizRole !== undefined && !是业务角色(改.bizRole)) return { ok: false, error: "没有这个角色" };
    if (改.line !== undefined && 改.line !== null && 改.line !== "内贸" && 改.line !== "外贸") return { ok: false, error: "业务线只能是内贸、外贸或两边都做" };
    if (改.deptId && !depts.some((d) => d.id === 改.deptId)) return { ok: false, error: "这个部门已经不在了，刷新看看" };

    const 原 = 建组织(users, members, depts);
    const 原角色 = 原.成员.get(userId)!.bizRole;
    if (!who.是老板 && (总管级(原角色) || 总管级(改.bizRole))) return { ok: false, error: "总管理、管理员这两个角色只有老板能给、能改" };

    // 带着这次改动重建一遍再查上级：一次同时改部门和上级时按改完的样子算
    const 旧行 = members.find((m) => m.userId === userId);
    const 新行 = {
      userId,
      deptId: 旧行?.deptId ?? null,
      bizRole: 旧行?.bizRole ?? 原角色,
      line: 旧行?.line ?? null,
      managerId: 旧行?.managerId ?? null,
      dottedManagerId: 旧行?.dottedManagerId ?? null,
      ...改,
    };
    const 新 = 建组织(users, [...members.filter((m) => m.userId !== userId), 新行], depts);
    const 问题 =
      (改.managerId !== undefined ? 上级设置问题(新, userId, 改.managerId, "直属") : null) ??
      (改.dottedManagerId !== undefined ? 上级设置问题(新, userId, 改.dottedManagerId, "虚线") : null);
    if (问题) return { ok: false, error: 问题 };

    await prisma.entMember.upsert({ where: { userId }, create: 新行, update: 改 });

    const 名 = (id: string | null | undefined) => (id ? users.find((u) => u.id === id)?.name ?? id : "不指定");
    const 说 = [
      改.deptId !== undefined && `部门 → ${改.deptId ? depts.find((d) => d.id === 改.deptId)!.name : "未分部门"}`,
      改.bizRole !== undefined && `角色 → ${角色名[改.bizRole as 业务角色]}`,
      改.line !== undefined && `业务线 → ${改.line ?? "两边都做"}`,
      改.managerId !== undefined && `直属上级 → ${名(改.managerId)}`,
      改.dottedManagerId !== undefined && `虚线上级 → ${名(改.dottedManagerId)}`,
    ].filter(Boolean);
    await recordAudit({ user: who.me, action: "update", entity: "EntMember", entityId: userId, summary: `组织架构：${人.name} ${说.join("，")}`, detail: 改 });
    改完了();
    return { ok: true };
  } catch (e) {
    return 不在了(e);
  }
}

/** 拨「按组织架构看客户」规则开关（默认关） */
export async function 设规则(on: boolean, 名: 规则名 = "按组织看客户"): Promise<结果> {
  const who = await 能改的人();
  if (!who) return 不能改;
  if (typeof on !== "boolean") return { ok: false, error: "开关只能开或关" };
  if (!Object.hasOwn(规则, 名)) return { ok: false, error: "没有这条规则" };
  const r = 规则[名];
  try {
    await setSetting(r.key, on);
    await recordAudit({ user: who.me, action: "update", entity: "Setting", entityId: r.key, summary: `${on ? "打开" : "关掉"}规则「${r.名}」` });
    改完了();
    return { ok: true };
  } catch (e) {
    return 不在了(e);
  }
}

/** 「后台设置谁能改」里管的那几样（字段权限表等）：企业版、不在共享区，再按表查；能改给 me，不能改给那句话 */
async function 能改这项(项: 设置项名): Promise<{ me: SessionUser } | { error: string }> {
  if (!企业版()) return { error: "这是企业版组织架构里的设置" };
  const me = await requireUser();
  const { 当前是共享区 } = await import("@/lib/shared-ws/current");
  if (await 当前是共享区()) return { error: "共享试用区不能改后台设置" };
  const 挡 = await 挡改设置(me, 项);
  return 挡 ? { error: `${设置项[项].名}${挡}` } : { me };
}

/** 存「角色 × 字段」表（规则「字段权限」开着才生效）；交来的先规整，只存和默认不一样的格 */
export async function 设字段权限(配置: unknown): Promise<结果> {
  const who = await 能改这项("字段权限");
  if ("error" in who) return { ok: false, error: who.error };
  try {
    const 存 = 规整字段配置(配置);
    await setSetting(字段权限key, 存);
    const 格数 = Object.values(存).reduce((n, 行) => n + Object.keys(行 ?? {}).length, 0);
    await recordAudit({ user: who.me, action: "update", entity: "Setting", entityId: 字段权限key, summary: `改字段权限表（${格数} 格不是「能改」）`, detail: 存 });
    改完了();
    return { ok: true };
  } catch (e) {
    return 不在了(e);
  }
}

/**
 * 存「后台设置谁能改」表（B2 第 6 条，10-26）：七样后台设置各由哪几类人改，没存的项 = 默认建议。
 * 只有老板和总管理员能改这张表本身（和组织架构同一道门）。
 */
export async function 设改权限(配置: unknown): Promise<结果> {
  const who = await 能改的人();
  if (!who) return 不能改;
  try {
    const 存 = 规整改权限(配置);
    await setSetting(改权限key, 存);
    const 说 = 设置项们.map((项) => `${设置项[项].名}：${["老板", ...谁能改(存, 项)].join("、")}`).join("；");
    await recordAudit({ user: who.me, action: "update", entity: "Setting", entityId: 改权限key, summary: `改后台设置谁能改（${说}）`, detail: 存 });
    改完了();
    return { ok: true };
  } catch (e) {
    return 不在了(e);
  }
}
