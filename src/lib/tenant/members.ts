/**
 * 托管版的「成员」：把工作区里的一个人，和一个能登录的控制面账号绑在一起。
 *
 * 自部署版没有这回事——那边登录直接查业务库的 `User`，管理员在「用户管理」里
 * 建一个人，那个人就能登录。托管版的登录走的是控制面的 `Account`
 * （见 lib/auth.ts 的 getCurrentUser），于是同样一个动作只建了业务库那条记录，
 * 结果是：**这个人有身份、有归属、能被选成负责人，就是进不来。**
 * 在那之前，一个托管版工作区实际上只有开号的那一个人能登录。
 *
 * 所以托管版建成员要同时落三样东西，缺一样人就进不来：
 *   Account          —— 控制面的「一个真人」，登录校验看的就是它
 *   Membership       —— 这个人属于这个工作区（resolveTenant 查的是它）
 *   WorkspaceAccount —— 账号 ↔ 业务库里那条 User 的映射（getCurrentUser 查的是它）
 *
 * 登录标识用**邮箱**而不是自部署那种用户名：控制面的账号本来就按邮箱/手机号认，
 * 而且忘了密码要靠它收验证码——用户名的话 /forgot 那条路对他是断的。
 */

import bcrypt from "bcryptjs";
import { control } from "./control";
import { checkPassword, findAccountByTarget, parseTarget } from "./accounts";
import { 记一次改密 } from "./session-cutoff";
import { 吊销全部 } from "./device-token";

export type 成员结果 = { ok: true; accountId: string } | { ok: false; error: string };

/**
 * 给一个刚建好的业务库 User 配一个能登录的账号。
 *
 * 邮箱已经有账号时**直接拒绝**，不做「顺手绑上去」。绑上去意味着任何一个工作区的
 * 管理员，只要知道你的邮箱就能把你拉进他的工作区——而登录时默认进的是第一个工作区，
 * 那等于能改变别人登录后看到的东西。真要支持「已有账号加入团队」，那是一条
 * 需要对方点头的邀请流程，不是这里顺手能做的事。
 */
export async function 配账号(input: {
  workspaceId: string;
  userId: string;
  email: string;
  password: string;
  name: string;
  role: string;
}): Promise<成员结果> {
  const t = parseTarget(input.email);
  if (!t || t.kind !== "email") return { ok: false, error: "请填写正确的邮箱，他要用它登录，也要用它找回密码" };
  const pwErr = checkPassword(input.password);
  if (pwErr) return { ok: false, error: pwErr };
  if (await findAccountByTarget(t.value)) {
    return { ok: false, error: "这个邮箱已经注册过账号了，请换一个。（把已有账号加进团队要对方同意，还没做）" };
  }

  const account = await control.account.create({
    data: {
      email: t.value,
      password: await bcrypt.hash(input.password, 10),
      name: input.name.trim().slice(0, 20) || "成员",
    },
  });
  try {
    await control.membership.create({
      data: { accountId: account.id, workspaceId: input.workspaceId, role: input.role === "ADMIN" ? "ADMIN" : "MEMBER" },
    });
  } catch (e) {
    // 建到一半的账号是垃圾：它能登录，但登录之后没有工作区
    await control.account.delete({ where: { id: account.id } }).catch(() => {});
    throw e;
  }
  return { ok: true, accountId: account.id };
}

/** 这条业务库 User 背后的控制面账号。自部署版、以及还没配账号的老成员，返回 null */
export async function 找账号(accountId: string | null | undefined) {
  if (!accountId) return null;
  return control.account.findUnique({ where: { id: accountId } });
}

/**
 * 改一个成员（或自己）的控制面密码。
 *
 * 改完两件事一起做，**改密码 = 到处都要重新登录**：
 *   记一次改密 —— 之前签出去的网页会话全部作废（见 session-cutoff.ts）
 *   吊销全部   —— 桌面端那几枚设备令牌也一起吊掉（见 device-token.ts）
 * 管理员替别人重置密码时这正是想要的：那个人手上的旧会话和旧机器都不该还留着。
 * 自己改密码的调用方要记得**当场再签一张新票**，否则会把自己也踢下线。
 */
export async function 改密码(accountId: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const pwErr = checkPassword(password);
  if (pwErr) return { ok: false, error: pwErr };
  await control.account.update({ where: { id: accountId }, data: { password: await bcrypt.hash(password, 10) } });
  await 记一次改密(accountId);
  await 吊销全部(accountId);
  return { ok: true };
}

/** 核对某个账号的当前密码。自己改密码时用 */
export async function 核对密码(accountId: string, password: string): Promise<boolean> {
  const a = await control.account.findUnique({ where: { id: accountId } });
  if (!a) return false;
  return bcrypt.compare(password, a.password);
}

/**
 * 停用 / 恢复一个成员在这个工作区里的成员资格。
 *
 * 业务库那条 User 的 active 已经能挡住登录（getCurrentUser 只认在职的），
 * 但那样他会被弹到登录页而不知道为什么。把 Membership 一起撤掉，
 * 登录那一步就会明确告诉他这个账号没有工作区。
 */
export async function 撤成员(accountId: string, workspaceId: string): Promise<void> {
  await control.membership.deleteMany({ where: { accountId, workspaceId } });
}

export async function 复成员(accountId: string, workspaceId: string, role: string): Promise<void> {
  await control.membership.upsert({
    where: { accountId_workspaceId: { accountId, workspaceId } },
    create: { accountId, workspaceId, role: role === "ADMIN" ? "ADMIN" : "MEMBER" },
    update: {},
  });
}
