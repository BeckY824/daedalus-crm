import fs from "node:fs";
import { control } from "./control";
import { listWorkspacesFor, resolveTenant } from "./workspaces";
import { workspaceClient, workspaceDbPath } from "./clients";

/** 成员关系与业务账号都存在且启用，才能进入目标库。到期库仍允许只读。 */
export async function accessibleWorkspace(accountId: string, workspaceId: string) {
  const account = await control.account.findUnique({ where: { id: accountId }, select: { active: true } });
  if (!account?.active) return null;
  const tenant = await resolveTenant(accountId, workspaceId);
  if (!tenant || !fs.existsSync(workspaceDbPath(tenant.dbFile))) return null;
  try {
    const db = workspaceClient(tenant.dbFile);
    const link = await db.workspaceAccount.findFirst({ where: { accountId } });
    if (!link || !(await db.user.findFirst({ where: { id: link.userId, active: true }, select: { id: true } }))) return null;
    return tenant;
  } catch {
    return null;
  }
}

export async function accessibleWorkspacesFor(accountId: string) {
  const list = await listWorkspacesFor(accountId);
  const accessible = await Promise.all(list.map(w => accessibleWorkspace(accountId, w.id)));
  return list.filter((_, i) => accessible[i] !== null);
}
