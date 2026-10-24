import { 认同步, 回 } from "@/lib/tenant/sync-auth";
import { 建部门, 改部门, 删部门, 设成员, 设角色范围, 邀请进组, 回邀请, 移出组, 进组名单 } from "@/lib/tenant/team-dept";

export const dynamic = "force-dynamic";

/**
 * 团队版 1b（2026-10-23）：部门、成员的部门和业务角色、「角色 × 范围」配置表、项目进组。body：{ teamId, action, ... }
 * 老版本桌面端不调这里；部门树和角色随 我的团队() 一起带回去
 */
export async function POST(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b.teamId !== "string") return Response.json({ error: "请求格式不对" }, { status: 400 });
  const { teamId, action } = b;
  const 我 = a.accountId;
  if (action === "dept-create") return 回(await 建部门(我, teamId, b.name, b.parentId));
  if (action === "dept-update") return 回(await 改部门(我, teamId, b.id, { name: b.name, parentId: b.parentId, sort: b.sort }));
  if (action === "dept-delete") return 回(await 删部门(我, teamId, b.id));
  if (action === "member") return 回(await 设成员(我, teamId, b.accountId, { bizRole: b.bizRole, deptId: b.deptId, dottedManagerId: b.dottedManagerId }));
  if (action === "role-scope") return 回(await 设角色范围(我, teamId, b.bizRole, b.scope));
  if (action === "invite") return 回(await 邀请进组(我, teamId, b.scopeId, b.accountId, b.groupRole, b.label));
  if (action === "invite-answer") return 回(await 回邀请(我, teamId, b.scopeId, b.accept));
  if (action === "invite-remove") return 回(await 移出组(我, teamId, b.scopeId, b.accountId));
  if (action === "invites") return 回(await 进组名单(我, teamId));
  return Response.json({ error: "未知操作" }, { status: 400 });
}
