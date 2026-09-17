"use server";

import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { ROLES } from "@/lib/constants";
import { recordAudit } from "@/lib/audit";
import { multiTenant } from "@/lib/tenant/context";
import { resolveCurrentTenant } from "@/lib/tenant/resolve";
import { 配账号, 改密码 as 改控制面密码, 核对密码, 撤成员, 复成员 } from "@/lib/tenant/members";
import { 列出 as 列出设备, 吊销 as 吊销设备 } from "@/lib/tenant/device-token";
import { 本地模式, 读 as 读云端凭据, 发码 as 云端发码, 重置密码 as 云端重置密码, 清 as 清云端凭据 } from "@/lib/desktop/cloud";
import { destroySession } from "@/lib/auth";
import { isEmail } from "@/lib/tenant/accounts";
import { createSession } from "@/lib/auth";
import { saveLlmConfig, clearLlmConfig, resolveLlmConfigForTest, testLlm, fetchRemoteModels, type ModelOption } from "@/lib/llm";
import { getBusiness, saveBusiness, mergeBusiness, type BusinessConfig } from "@/lib/business";

/** 密码最短长度。界面上有校验，但接口直调能绕开，空密码会让任何人登进来 */
const MIN_PASSWORD = 8;

/**
 * 登录用户名的格式。**这个字段存的是登录名，不是邮箱**——
 * 界面上填什么、登录页就用什么登，既有账号是 admin / zhangsan / lisi。
 * 登录时会 toLowerCase 后比对，所以这里只收小写，避免填了 LiSi 却登不进去。
 */
const 用户名格式 = /^[a-z0-9._-]{2,32}$/;

/** 命中同名在职成员时回传，供界面弹窗让人确认 */
export type NameDuplicate = { name: string; email: string; title: string };

/**
 * 设置页的所有写操作都要过这里。
 *
 * **演示区一律拒绝**，即便它那个用户的角色是 ADMIN。演示区是所有人共用的，
 * 进门不要账号也不要密码（见 app/demo/actions.ts），于是「管理员」这个身份
 * 在那里等于「任何人」。放它过去至少有两件事会当场出问题：
 *   - AI 接入那一栏的「测试连接」会把服务端的 LLM Key 发到调用方自己填的地址；
 *   - 业务配置、成员、角色随便改，而演示区是给下一个访客看的。
 * 演示区本来就每晚重置，少这几个按钮不影响它要演示的东西。
 */
/** 这个部署是不是托管版。托管版的「能不能登录」由控制面说了算，见 lib/tenant/members.ts */
function 托管版(): boolean {
  return multiTenant();
}

async function requireAdmin() {
  const me = await requireUser();
  if (me.role !== "ADMIN") throw new Error("FORBIDDEN");
  const { 当前是共享区 } = await import("@/lib/shared-ws/current");
  if (await 当前是共享区()) throw new Error("FORBIDDEN");
  return me;
}

/**
 * 拦住「把最后一个管理员弄没」的操作。
 *
 * 停用自己、或把自己降成销售，在只剩一个管理员时会让整个系统再也没人能管成员、
 * 改角色、做数据转交——只能改库才能救回来。这类操作界面上完全允许，
 * 而且做完当场看不出问题，下次要加人时才发现。
 */
async function wouldLoseLastAdmin(targetId: string): Promise<boolean> {
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { role: true, active: true } });
  if (!target || target.role !== "ADMIN" || !target.active) return false;
  const others = await prisma.user.count({
    where: { id: { not: targetId }, role: "ADMIN", active: true },
  });
  return others === 0;
}

export async function saveUser(input: {
  id?: string;
  name: string;
  email: string;
  title: string;
  role: string;
  password?: string | null;
  active: boolean;
  /** 用户已在弹窗里确认「确实是另一个人」 */
  force?: boolean;
}): Promise<
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; duplicateName: NameDuplicate }
> {
  const me = await requireAdmin();

  if (!ROLES.some((r) => r.value === input.role)) {
    return { ok: false as const, error: `角色「${input.role}」不是合法取值` };
  }
  const 登录名 = input.email.trim().toLowerCase();
  /**
   * 两种部署的登录标识不是一回事，校验也不能共用一条：
   *   自部署 —— 用户名（admin / zhangsan），业务库的 User 直接参与登录校验
   *   托管版 —— 邮箱，登录校验走控制面账号，而且找回密码要靠它收验证码
   * 之前这里只有用户名那条正则，托管版填邮箱会被 `@` 卡死——界面改成邮箱之后
   * 保存永远失败，而失败的话说的还是「只能用小写字母、数字和 . _ -」。
   */
  if (托管版()) {
    if (!isEmail(登录名)) return { ok: false as const, error: "请填写正确的邮箱，他要用它登录，也要用它找回密码" };
  } else if (!用户名格式.test(登录名)) {
    return {
      ok: false as const,
      error: "登录用户名只能用小写字母、数字和 . _ -，长度 2–32 位",
    };
  }
  if (input.password && input.password.length < MIN_PASSWORD) {
    return { ok: false as const, error: `密码至少 ${MIN_PASSWORD} 位` };
  }
  if (input.id && (input.role !== "ADMIN" || !input.active) && (await wouldLoseLastAdmin(input.id))) {
    return {
      ok: false as const,
      error: "这是系统里最后一个管理员，不能停用或降级，否则将无人可以管理成员。请先指定另一位管理员。",
    };
  }
  /**
   * 停用必须走「停用并转交」，不能在编辑框里勾掉。
   * 直接勾掉的话名下学员、商机、待办全留在一个已停用的人名下，
   * 而各处下拉只列在职成员，这些数据的负责人就变成一个选不出来的空值。
   */
  if (input.id && !input.active) {
    const before = await prisma.user.findUnique({ where: { id: input.id }, select: { active: true } });
    if (before?.active) {
      return { ok: false as const, error: "请使用「停用」按钮，停用时需要指定名下数据转交给谁" };
    }
  }

  /**
   * 同名成员不硬拦——同名同事在真实团队里很正常，拦下来管理员就建不了人。
   * 但重名之后各处负责人下拉会出现两个一样的选项，所以要确认一次；
   * 确认过就照建，下拉那边会自动把登录名带出来做区分。
   */
  if (!input.force) {
    const 同名 = await prisma.user.findFirst({
      where: {
        name: input.name.trim(),
        active: true,
        ...(input.id ? { id: { not: input.id } } : {}),
      },
      select: { name: true, email: true, title: true },
    });
    if (同名) return { ok: false as const, duplicateName: 同名 };
  }

  const base = {
    name: input.name.trim(),
    email: 登录名,
    title: input.title,
    role: input.role,
    active: input.active,
  };

  if (input.id) {
    if (托管版()) {
      /**
       * 托管版的密码在控制面，业务库那一列存的是不可用的占位符。
       * 写进业务库的话「重置了密码」会显示成功，而那个人用新密码照样登不进来。
       * 登录名（email）在托管版**不能改**：它同时是控制面账号的标识，
       * 改一边不改另一边就对不上了；界面上那一栏在编辑时是锁住的。
       */
      const link = await prisma.workspaceAccount.findFirst({ where: { userId: input.id } });
      if (input.password) {
        if (!link) return { ok: false as const, error: "这个成员还没有可登录的账号（老数据），请删掉重建" };
        const r = await 改控制面密码(link.accountId, input.password);
        if (!r.ok) return r;
      }
      const { email: _忽略登录名, ...可改 } = base;
      await prisma.user.update({ where: { id: input.id }, data: 可改 });
    } else {
      await prisma.user.update({
        where: { id: input.id },
        data: input.password
          ? { ...base, password: await bcrypt.hash(input.password, 10) }
          : base,
      });
    }
  } else {
    if (!input.password) return { ok: false as const, error: "新成员必须设置初始密码" };
    const exists = await prisma.user.findUnique({ where: { email: base.email } });
    if (exists) return { ok: false as const, error: 托管版() ? "这个邮箱在本工作区已经有人用了" : "该登录用户名已被占用" };

    /**
     * **托管版要连控制面账号一起建，不然这个人进不来。**
     * 那边登录校验的是控制面的 Account，业务库这条记录的 password 根本不参与——
     * 只建业务库那条的话，他有身份、有归属、能被选成负责人，就是登不进去。
     * 见 lib/tenant/members.ts。
     */
    if (托管版()) {
      const t = await resolveCurrentTenant();
      if (!t) return { ok: false as const, error: "解析不到当前工作区，请刷新重试" };
      const user = await prisma.user.create({ data: { ...base, password: "!managed" } });
      const 配 = await 配账号({
        workspaceId: t.workspaceId,
        userId: user.id,
        email: base.email,
        password: input.password,
        name: base.name,
        role: base.role,
      });
      if (!配.ok) {
        // 账号没配成，业务库那条也不能留：留着就是一个永远登不进来的人
        await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
        return 配;
      }
      await prisma.workspaceAccount.create({ data: { userId: user.id, accountId: 配.accountId } });
    } else {
      await prisma.user.create({
        data: { ...base, password: await bcrypt.hash(input.password, 10) },
      });
    }
  }

  await recordAudit({
    user: me, action: input.id ? "update" : "create", entity: "User", entityId: input.id ?? null,
    summary: `${input.id ? "修改" : "新建"}成员「${base.name}」（${base.role}）` +
      (input.password ? "，并重置了密码" : "") +
      (input.force ? "（已确认与既有同名成员不是同一人）" : ""),
    detail: { name: base.name, email: base.email, role: base.role, active: base.active },
  });

  revalidatePath("/settings");
  return { ok: true as const };
}

/**
 * 停用成员前先把名下数据转交他人。
 *
 * 托管版还要把控制面的成员资格一起撤掉：光把业务库那条设成 active=false
 * 也能挡住他（getCurrentUser 只认在职的），但他会被静静地弹回登录页，
 * 不知道为什么。撤掉成员资格之后，登录那一步会明确说这个账号没有工作区。
 */
export async function deactivateUser(id: string, transferToId: string) {
  const me = await requireAdmin();
  if (id === transferToId) return { ok: false as const, error: "不能转交给自己" };

  const receiver = await prisma.user.findUnique({
    where: { id: transferToId },
    select: { active: true },
  });
  // 转交给一个已停用的人等于把数据丢进黑洞：各处下拉只列在职成员，之后谁都选不到
  if (!receiver?.active) {
    return { ok: false as const, error: "接收人不存在或已停用，请选择一位在职成员" };
  }
  if (await wouldLoseLastAdmin(id)) {
    return {
      ok: false as const,
      error: "这是系统里最后一个管理员，停用后将无人可以管理成员。请先指定另一位管理员。",
    };
  }

  await prisma.$transaction([
    prisma.customer.updateMany({ where: { salesOwnerId: id }, data: { salesOwnerId: transferToId } }),
    prisma.opportunity.updateMany({ where: { ownerId: id }, data: { ownerId: transferToId } }),
    prisma.task.updateMany({ where: { ownerId: id }, data: { ownerId: transferToId } }),
    prisma.followPlan.updateMany({ where: { ownerId: id }, data: { ownerId: transferToId } }),
    /**
     * 这两类原本漏了转交：
     *   线索      —— 留在停用的人名下，列表按负责人筛选时谁都看不到，等于丢了
     *   渠道负责人 —— Channel.channelOwnerId 还指着停用的人，
     *                之后这个渠道新带来的学员会继续算到一个离职的人头上
     * 学员身上冗余的 channelOwnerId 也要跟着改，否则筛选统计对不上。
     */
    prisma.lead.updateMany({ where: { ownerId: id }, data: { ownerId: transferToId } }),
    prisma.channel.updateMany({ where: { channelOwnerId: id }, data: { channelOwnerId: transferToId } }),
    prisma.customer.updateMany({ where: { channelOwnerId: id }, data: { channelOwnerId: transferToId } }),
    prisma.user.update({ where: { id }, data: { active: false } }),
  ]);

  if (托管版()) {
    const t = await resolveCurrentTenant();
    const link = await prisma.workspaceAccount.findFirst({ where: { userId: id } });
    if (t && link) await 撤成员(link.accountId, t.workspaceId);
  }

  const [被停, 接手] = await Promise.all([
    prisma.user.findUnique({ where: { id }, select: { name: true } }),
    prisma.user.findUnique({ where: { id: transferToId }, select: { name: true } }),
  ]);
  await recordAudit({
    user: me, action: "deactivate", entity: "User", entityId: id,
    summary: `停用成员「${被停?.name ?? id}」，名下数据转交给「${接手?.name ?? transferToId}」`,
    detail: { userId: id, transferToId },
  });

  revalidatePath("/settings");
  revalidatePath("/customers");
  revalidatePath("/leads");
  revalidatePath("/channels");
  return { ok: true as const };
}

export async function reactivateUser(id: string) {
  const me = await requireAdmin();
  const u = await prisma.user.update({ where: { id }, data: { active: true } });
  // 托管版：停用时撤掉的成员资格要加回来，否则他登录会被告知「没有工作区」
  if (托管版()) {
    const t = await resolveCurrentTenant();
    const link = await prisma.workspaceAccount.findFirst({ where: { userId: id } });
    if (t && link) await 复成员(link.accountId, t.workspaceId, u.role);
  }
  await recordAudit({
    user: me, action: "reactivate", entity: "User", entityId: id,
    summary: `恢复成员「${u.name}」`,
  });
  revalidatePath("/settings");
  return { ok: true as const };
}

/**
 * 改自己的密码。任何人都可以改自己的。
 *
 * **托管版改的是控制面那把。** 业务库这一列存的是不可用的占位符 `!managed`
 * （见 lib/tenant/workspaces.ts），拿它去 bcrypt.compare 永远不成立——
 * 也就是说在那之前，托管版里**没有人改得了自己的密码**，界面一律回「原密码错误」。
 * 我们发给试用公司的初始密码，他们自己换不掉。
 */
export async function changeMyPassword(oldPwd: string, newPwd: string) {
  const me = await requireUser();
  const user = await prisma.user.findUnique({ where: { id: me.id } });
  if (!user) return { ok: false as const, error: "用户不存在" };

  const link = 托管版() ? await prisma.workspaceAccount.findFirst({ where: { userId: me.id } }) : null;
  if (托管版() && !link) return { ok: false as const, error: "这个账号还没接到登录体系上，请联系我们" };
  /**
   * 工作区要**在改密之前**解析好。改完之后手上这张票就作废了，
   * 那时再去解析只会拿到 null，续出来的新票没有 ws 字段，
   * 结果是「改完密码页面全都打不开」。
   */
  const 我的工作区 = link ? (await resolveCurrentTenant())?.workspaceId : undefined;

  const 对得上 = link ? await 核对密码(link.accountId, oldPwd) : await bcrypt.compare(oldPwd, user.password);
  if (!对得上) return { ok: false as const, error: "原密码错误" };
  // 界面上有长度校验，但接口直调能绕开——空密码会让任何人用这个账号登进来
  if (!newPwd || newPwd.length < MIN_PASSWORD) {
    return { ok: false as const, error: `新密码至少 ${MIN_PASSWORD} 位` };
  }
  if (newPwd === oldPwd) {
    return { ok: false as const, error: "新密码不能与原密码相同" };
  }
  if (link) {
    const r = await 改控制面密码(link.accountId, newPwd);
    if (!r.ok) return r;
    /**
     * 改密会把这个账号之前签出去的会话全部作废，包括**我自己现在这张**。
     * 当场再签一张：改完密码被踢回登录页，没人会觉得那是「安全」。
     * 别的设备上那些票据的 iat 更早，照样进不来。
     */
    await createSession(link.accountId, 我的工作区);
  } else {
    await prisma.user.update({
      where: { id: me.id },
      data: { password: await bcrypt.hash(newPwd, 10) },
    });
  }
  // 只记「改过密码」这件事，不记任何密码内容
  await recordAudit({
    user: me, action: "password", entity: "User", entityId: me.id,
    summary: `${me.name} 修改了自己的登录密码`,
  });
  return { ok: true as const };
}

/* ---------- 已登录的机器 ---------- */

/**
 * 这个人背后的控制面账号。设备令牌挂在它名下，不在业务库那条 User 上。
 *
 * 两种情况返回 null，那时「已登录的机器」整栏不出现：
 *   自部署版    —— 桌面端不连我们的控制面，也就没有设备令牌这回事；
 *   共享工作区  —— 那一套账号密码发给了多个团队（见 shared-ws/current.ts），
 *                  列表里会是别的团队的机器名，而「退出」能把他们正在用的机器踢下线。
 */
async function 我的控制面账号(userId: string): Promise<string | null> {
  if (!托管版()) return null;
  const { 当前是共享区 } = await import("@/lib/shared-ws/current");
  if (await 当前是共享区()) return null;
  const link = await prisma.workspaceAccount.findUnique({ where: { userId } });
  return link?.accountId ?? null;
}

/** 一台已登录的机器。时间序列化成字符串——这东西要过 Server → Client 那道边界 */
export type 机器 = { id: string; 名字: string; 登录于: string; 最近使用: string | null };

/**
 * 我这个账号上还活着的设备令牌。**null 表示这一栏不适用**，空数组表示一台都没有。
 *
 * 改密码是一把大闩，一拉全部退出（见 members.ts 的 改密码）。但「只丢了备用本，
 * 不想让另外两台重登」之前没有任何路：`列出` / `吊销` 两个函数一直是现成的，
 * 界面上一处都没有（`列出` 全仓引用次数曾经是 0）。这一栏就是那个缺口。
 */
export async function 我的机器(): Promise<机器[] | null> {
  const me = await requireUser();
  const accountId = await 我的控制面账号(me.id);
  if (!accountId) return null;
  return (await 列出设备(accountId)).map((d) => ({
    id: d.id,
    名字: d.name,
    登录于: d.createdAt.toISOString(),
    最近使用: d.lastUsedAt?.toISOString() ?? null,
  }));
}

/**
 * 退出其中一台。
 *
 * `吊销` 的第二个参数就是那道闸：少了它，猜到一个 id 就能把别人的机器踢下线
 * （gateway.test.ts 钉着这条）。这里只传自己的 accountId，别人的 id 传进来会一无所获。
 *
 * 那台机器不用等到下次调 AI 才发现：它切回前台时会问一句自己还认不认
 * （cloud.js 的 校验），然后说清原因回到登录界面。
 */
export async function 退出这台机器(id: string) {
  const me = await requireUser();
  const accountId = await 我的控制面账号(me.id);
  if (!accountId) return { ok: false as const, error: "这个部署没有云端账号，也就没有已登录的机器" };
  // 名字要在吊销之前取：吊销之后 列出 就查不到它了，而日志里得写清是哪一台
  const 名字 = (await 列出设备(accountId)).find((d) => d.id === id)?.name ?? "";
  if (!(await 吊销设备(id, accountId))) {
    return { ok: false as const, error: "这台机器已经退出了" };
  }
  await recordAudit({
    user: me, action: "device_revoke", entity: "Device", entityId: id,
    summary: `${me.name} 退出了已登录的机器「${名字 || "未命名设备"}」`,
  });
  revalidatePath("/settings");
  return { ok: true as const };
}

/* ---------- AI 接入 ---------- */

/**
 * 保存 AI 接入配置。只有管理员能改；日志只记"改了"，不记任何值——
 * 地址与模型名无所谓，但同一条日志里不能出现 key，哪怕是尾号。
 */
export async function saveLlmSettings(input: { baseUrl: string; model: string; apiKey?: string | null; options?: ModelOption[] }) {
  const me = await requireAdmin();
  if (!/^https?:\/\//.test(input.baseUrl.trim())) {
    return { ok: false as const, error: "接口地址要以 http:// 或 https:// 开头" };
  }
  if (!input.model.trim()) return { ok: false as const, error: "请填写模型名" };
  await saveLlmConfig(input);
  await recordAudit({ user: me, action: "update", entity: "Setting", entityId: "llm", summary: "修改了 AI 接入配置" });
  revalidatePath("/", "layout");
  return { ok: true as const };
}

export async function clearLlmSettings() {
  const me = await requireAdmin();
  await clearLlmConfig();
  await recordAudit({ user: me, action: "update", entity: "Setting", entityId: "llm", summary: "清除了界面里的 AI 接入配置" });
  revalidatePath("/", "layout");
  return { ok: true as const };
}

/** 问接口它支持哪些模型，给设置页挑。拉不到就手填，不阻塞配置 */
export async function listRemoteModels(input: { baseUrl: string; apiKey?: string | null }) {
  await requireAdmin();
  if (!/^https?:\/\//.test(input.baseUrl.trim())) {
    return { ok: false as const, error: "接口地址要以 http:// 或 https:// 开头" };
  }
  return fetchRemoteModels(input);
}

/** 用表单里当前填的值发一次最小请求；key 留空则用已保存的 */
export async function testLlmSettings(input: { baseUrl: string; model: string; apiKey?: string | null }) {
  await requireAdmin();
  if (!/^https?:\/\//.test(input.baseUrl.trim())) {
    return { ok: false as const, error: "接口地址要以 http:// 或 https:// 开头" };
  }
  const cfg = await resolveLlmConfigForTest(input);
  if (!cfg) return { ok: false as const, error: "还没有 API Key：请先填写" };
  return testLlm(cfg);
}

/* ---------- 业务配置 ---------- */

export async function saveBusinessSettings(cfg: BusinessConfig) {
  const me = await requireAdmin();
  const merged = mergeBusiness(cfg);
  if (merged.customer.length > 6) return { ok: false as const, error: "核心名词请控制在 6 个字以内，它会出现在表头和按钮上" };
  if (merged.brief.length > 500) return { ok: false as const, error: "业务简介请控制在 500 字以内" };
  const before = await getBusiness();
  await saveBusiness(merged);
  const changed = (Object.keys(merged) as (keyof BusinessConfig)[]).filter(
    (k) => JSON.stringify(merged[k]) !== JSON.stringify(before[k]),
  );
  await recordAudit({
    user: me, action: "update", entity: "Setting", entityId: "business",
    summary: `修改了业务配置：${changed.length ? changed.map((k) => BUSINESS_FIELD_LABELS[k]).join("、") : "无实际变化"}`,
    detail: Object.fromEntries(changed.map((k) => [BUSINESS_FIELD_LABELS[k], { 改前: before[k], 改后: merged[k] }])),
  });
  revalidatePath("/", "layout");
  return { ok: true as const };
}

const BUSINESS_FIELD_LABELS: Record<keyof BusinessConfig, string> = {
  brief: "业务简介", customer: "核心名词", fields: "档案字段名", grades: "年级选项", sources: "线索来源", industries: "行业选项", statusLabels: "状态显示名",
};

/* ---------- 桌面端 ---------- */

/**
 * 桌面端改云端账号密码的两步。账号不让前端传：改的只能是**当前登录的那个**，
 * 目标从本机那份 .cloud.json 里取。
 */
export async function 桌面端发码(): Promise<{ ok: true; hint?: string } | { ok: false; error: string }> {
  await requireUser();
  const c = 读云端凭据();
  if (!本地模式() || !c) return { ok: false, error: "这个入口只有桌面端有" };
  const r = await 云端发码(c.contact);
  return r.ok ? { ok: true, hint: r.data?.hint } : { ok: false, error: r.error };
}

/**
 * 改完 = 所有机器退出，这台也在内：令牌已经在云端作废了，本地那份清掉、业务会话也清掉，
 * 前端接着送去登录页。留着只会让人看到一个「还登录着」的界面，而 AI 在背后一路 401。
 */
export async function 桌面端改密码(input: { code: string; password: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireUser();
  const c = 读云端凭据();
  if (!本地模式() || !c) return { ok: false, error: "这个入口只有桌面端有" };
  const r = await 云端重置密码({ target: c.contact, code: input.code, password: input.password });
  if (!r.ok) return { ok: false, error: r.error };
  清云端凭据();
  await destroySession();
  return { ok: true };
}
