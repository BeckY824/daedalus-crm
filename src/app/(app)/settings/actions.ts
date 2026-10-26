"use server";

import { 补来源 } from "@/lib/customer-extra-db";

import { 钉住老签约 } from "@/lib/contract-owner";
import { 企业版 } from "@/lib/enterprise/switch";
import { 读组织, 直属上级of } from "@/lib/enterprise/org";
import { 规则开着 } from "@/lib/enterprise/rules";
import { 停用分拣, 停用方式们, type 停用方式 } from "@/lib/offboard-db";
import { 离职转给接手人, 离职放进公海 } from "@/lib/offboard-move";
import { 交接要确认, 离职交接中, 了结 } from "@/lib/enterprise/handover-db";
import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { ROLES } from "@/lib/constants";
import { recordAudit } from "@/lib/audit";
import { 读令牌, 生成令牌, 撤销令牌 } from "@/lib/mcp/token";
import { MCP地址 } from "@/lib/mcp/address";
import { multiTenant } from "@/lib/tenant/context";
import { resolveCurrentTenant } from "@/lib/tenant/resolve";
import { 配账号, 改密码 as 改控制面密码, 核对密码, 撤成员, 复成员, 是创建者 } from "@/lib/tenant/members";
import { 列出 as 列出设备, 吊销 as 吊销设备 } from "@/lib/tenant/device-token";
import { 本地模式, 读 as 读云端凭据, 发码 as 云端发码, 重置密码 as 云端重置密码, 清 as 清云端凭据 } from "@/lib/desktop/cloud";
import { destroySession } from "@/lib/auth";
import { 本机我 } from "@/lib/desktop/me";
import { 云端跟着改名 } from "@/lib/desktop/my-name";
import { 调云 } from "@/lib/sync/client";
import { isEmail } from "@/lib/tenant/accounts";
import { createSession } from "@/lib/auth";
import { saveLlmConfig, clearLlmConfig, resolveLlmConfigForTest, testLlm, type ModelOption } from "@/lib/llm";
import { getBusiness, saveBusiness, mergeBusiness, 状态名问题, 阶段名问题, type BusinessConfig } from "@/lib/business";
import { 判断可用 } from "@/lib/jev/client";
import { 自动判断开着, 设自动判断 } from "@/lib/jev/settings";

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

/** 这个部署是不是托管版。托管版的「能不能登录」由控制面说了算，见 lib/tenant/members.ts */
function 托管版(): boolean {
  return multiTenant();
}

/**
 * 设置页的所有写操作都要过这里。
 *
 * **网页的共享工作区一律拒绝**，即便登进去的那个账号角色是 ADMIN。那一套账号密码是
 * 发给好几个团队共用的（见 lib/shared-ws），于是「管理员」这个身份在那里等于「任何人」。
 * 放它过去至少有两件事会当场出问题：
 *   - AI 接入那一栏的「测试连接」会把服务端的 LLM Key 发到调用方自己填的地址；
 *   - 业务配置、成员、角色随便改，而别的团队也在用同一个工作区。
 */
/** 当前是不是网页试用版那个共享工作区 */
async function 是共享区() {
  const { 当前是共享区 } = await import("@/lib/shared-ws/current");
  return 当前是共享区();
}

async function requireAdmin() {
  const me = await requireUser();
  if (me.role !== "ADMIN") throw new Error("FORBIDDEN");
  const { 当前是共享区 } = await import("@/lib/shared-ws/current");
  if (await 当前是共享区()) throw new Error("FORBIDDEN");
  return me;
}

/**
 * 谁能给这个人办离职（停用、停用前清点）：管理员；企业版再加上他的直属上级（D-36）。
 * 上级不能停用管理员。不是企业版和原来一样，只认管理员。
 * 直属上级这一条跟「按组织看客户」开关走：开关关着时组织只是一张表，上级不多出权限（同 lib/project/db 直属才推）
 */
async function 能办离职(id: string) {
  if (!企业版()) return requireAdmin();
  const me = await requireUser();
  if (me.role === "ADMIN") return requireAdmin();
  if (await 是共享区()) throw new Error("FORBIDDEN");
  const 他 = typeof id === "string" && id ? await prisma.user.findUnique({ where: { id }, select: { role: true } }) : null;
  if (他 && 他.role !== "ADMIN" && (await 规则开着("按组织看客户")) && 直属上级of(await 读组织(), id) === me.id) return me;
  throw new Error("FORBIDDEN");
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

  if (!input || typeof input !== "object" || typeof input.name !== "string" || !input.name.trim() ||
      typeof input.email !== "string" || typeof input.title !== "string" || typeof input.role !== "string" ||
      typeof input.active !== "boolean" || (input.id !== undefined && (typeof input.id !== "string" || !input.id)) ||
      (input.password != null && typeof input.password !== "string")) {
    return { ok: false, error: "成员信息不完整或格式不正确" };
  }
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
    const 之前 = await prisma.user.findUnique({ where: { id: input.id }, select: { active: true } });
    if (!之前) return { ok: false, error: "这个成员已不存在，请刷新重试" };
    if (托管版()) {
      /**
       * 托管版的密码在控制面，业务库那一列存的是不可用的占位符。
       * 写进业务库的话「重置了密码」会显示成功，而那个人用新密码照样登不进来。
       * 登录名（email）在托管版**不能改**：它同时是控制面账号的标识，
       * 改一边不改另一边就对不上了；界面上那一栏在编辑时是锁住的。
       */
      const link = await prisma.workspaceAccount.findFirst({ where: { userId: input.id } });
      const 恢复 = !之前.active && input.active;
      const t = 恢复 ? await resolveCurrentTenant() : null;
      if (恢复 && (!link || !t)) return { ok: false, error: "无法恢复成员的登录资格，请刷新重试或联系管理员" };
      // 密码在控制面、在职状态在业务库，避免恢复失败却已改掉密码的部分结果。
      if (恢复 && input.password) return { ok: false, error: "请先恢复成员，再单独重置密码" };
      if (input.password) {
        if (!link) return { ok: false as const, error: "这个成员还没有可登录的账号（老数据），请删掉重建" };
        const r = await 改控制面密码(link.accountId, input.password);
        if (!r.ok) return r;
      }
      const { email: _忽略登录名, ...可改 } = base;
      /*
        在编辑框里把停用的人拨回在职：和「恢复」按钮一样，把停用时撤掉的成员资格补回来。
        原来只改了业务库的 active，提示「已保存」，那个人照样登不进来（2026-10-02 排查 A4）
      */
      try {
        await prisma.$transaction(async (tx) => {
          await tx.user.update({ where: { id: input.id }, data: 可改 });
          if (恢复 && link && t) await 复成员(link.accountId, t.workspaceId, input.role);
        });
      } catch (error) {
        console.error("保存托管成员失败：", error);
        return { ok: false, error: 恢复 ? "成员保存失败，登录资格未恢复，请稍后重试" : "成员保存失败，请稍后重试" };
      }
    } else {
      const occupied = await prisma.user.findUnique({ where: { email: base.email }, select: { id: true } });
      if (occupied && occupied.id !== input.id) return { ok: false, error: "该登录用户名已被占用" };
      try {
        await prisma.user.update({
          where: { id: input.id },
          data: input.password ? { ...base, password: await bcrypt.hash(input.password, 10) } : base,
        });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "P2002") return { ok: false, error: "该登录用户名已被占用" };
        throw error;
      }
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
export async function deactivateUser(id: string, transferToId: string, 方式: 停用方式 = "转交") {
  const me = await 能办离职(id);
  if (!停用方式们.includes(方式)) return { ok: false as const, error: "交接方式不对，刷新再试" };
  if (方式 === "公海" && !企业版()) return { ok: false as const, error: "放进公海交接是企业版的功能" };
  // 必须在业务库转交、停用之前拒绝，不能写到一半才发现永久 OWNER 身份丢失。
  if (托管版()) {
    const t = await resolveCurrentTenant();
    const link = await prisma.workspaceAccount.findFirst({ where: { userId: id } });
    if (t && link && await 是创建者(link.accountId, t.workspaceId)) {
      return { ok: false as const, error: "工作区创建者不能停用" };
    }
  }
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
  // 企业版「交接中」：上一次离职交接还没确认，不能再交给第二个人（先撤回再办）
  if (企业版() && (await 离职交接中(id))) {
    return { ok: false as const, error: "这位成员的离职交接还在等接手人确认：先在客户页「交接中」里撤回，再重新办" };
  }

  /*
    转交的是「往后要跟的活」，不是历史（2026-10-02 排查 B2，09 月拍板「谁的数据没动，谁的归属就不变」）：
      客户的销售负责人、线索、渠道（管以后新来的）—— 全转，不然没人跟
      商机 —— 只转进行中的；赢单、丢单的留在他名下，业绩排行按赢单商机算
      计划、待办 —— 只转没完成的；完成了的是他做的
      已有客户身上的渠道负责人 —— **不改写**：那是业绩归属，不是活。原来这里一起改了，
        他带来的学员整批算到接手人头上（签约的业绩现在按签约那一刻记，见 lib/contract-owner.ts）
    企业版离职交接（D-36）多了「放进公海」方式，哪些给接手人、哪些进公海见 lib/offboard-db.ts 停用分拣。
    转走了哪些记下 id，留痕里查得到，要手工退回也有据可依。
  */
  // 转之前先钉住老签约「签约那一刻是谁的」：停用留痕说「历史业绩不动」，就得真不动（2026-10-02 排查 X1）
  await 钉住老签约();
  const 记分配 = await 规则开着("线索分配");
  // 函数式事务：数组式在托管版的工作区代理下会抛错，而且抛之前已经写了（2026-10-02 排查 A3）。
  // 分拣也放在事务里：清点到写完之间有人改了负责人，不会漏转、错转。一个人名下一两百条，给足时间
  // 企业版「交接中」（规则「交接要接手人确认」，D10）：给接手人的那部分等他确认，见 lib/enterprise/handover-db.ts
  if (await 交接要确认()) return 发起离职交接(me, id, transferToId, 方式);
  const 转走了 = await prisma.$transaction(async (tx) => {
    const 分 = await 停用分拣(tx, id, 方式, 企业版());
    const 项目 = await 离职转给接手人(tx, 分, id, transferToId, me.id, 记分配);
    await 离职放进公海(tx, 分, me.id);
    await tx.user.update({ where: { id }, data: { active: false } });
    const { 订单项目: _, ...记 } = 分;
    return { ...记, 项目 };
  }, { timeout: 30_000 });

  await 撤托管成员(id);

  const [被停, 接手] = await Promise.all([
    prisma.user.findUnique({ where: { id }, select: { name: true } }),
    prisma.user.findUnique({ where: { id: transferToId }, select: { name: true } }),
  ]);
  const 进公海 = 转走了.进公海客户.length + 转走了.本来在公海.length;
  await recordAudit({
    user: me, action: "deactivate", entity: "User", entityId: id,
    summary: `停用成员「${被停?.name ?? id}」，转交给「${接手?.name ?? transferToId}」：` +
      `${转走了.客户.length} 位客户、${转走了.商机.length} 个进行中商机、${转走了.计划.length + 转走了.待办.length} 条没完成的计划和待办、` +
      `${转走了.线索.length} 条线索、${转走了.渠道.length} 个渠道` + (转走了.项目.length ? `、${转走了.项目.length} 个项目` : "") +
      (方式 === "公海" ? `；${进公海} 位客户放进公海` + (转走了.进公海项目.length ? `、${转走了.进公海项目.length} 个项目放回项目公海` : "") : "") +
      "（历史业绩不动）",
    // 转交时详情和开关加入前一字不差（差分测试逐字段比）；只有放进公海才多记方式和进公海的清单
    detail: 方式 === "公海"
      ? { userId: id, transferToId, 方式, 转走了 }
      : {
          userId: id, transferToId,
          转走了: {
            客户: 转走了.客户, 商机: 转走了.商机, 待办: 转走了.待办, 计划: 转走了.计划, 线索: 转走了.线索, 渠道: 转走了.渠道,
            ...(转走了.项目.length ? { 项目: 转走了.项目 } : {}),
          },
        },
  });

  revalidatePath("/settings");
  revalidatePath("/customers");
  revalidatePath("/leads");
  revalidatePath("/channels");
  revalidatePath("/projects");
  return { ok: true as const };
}

async function 撤托管成员(id: string) {
  if (!托管版()) return;
  const t = await resolveCurrentTenant();
  const link = await prisma.workspaceAccount.findFirst({ where: { userId: id } });
  if (t && link) await 撤成员(link.accountId, t.workspaceId);
}

/**
 * 企业版「交接中」的离职（规则「交接要接手人确认」开着，D10）：成员当场停用（离职的人不能再登录），
 * 放进公海的那部分当场放；给接手人的那部分先不动、留在他名下，记一行待确认，接手人在客户页确认了
 * 才按那时候重新分拣、转过去（customers/handover-actions.ts 确认交接）。确认前接手人的列表里看不到这些数据
 */
async function 发起离职交接(me: Awaited<ReturnType<typeof requireUser>>, id: string, transferToId: string, 方式: 停用方式) {
  const { 分, 交接 } = await prisma.$transaction(async (tx) => {
    const 分 = await 停用分拣(tx, id, 方式, true);
    await 离职放进公海(tx, 分, me.id);
    const h = await tx.entHandover.create({
      data: {
        kind: "离职", fromUserId: id, toUserId: transferToId, byUserId: me.id, way: 方式,
        customerIds: JSON.stringify(分.客户),
        counts: JSON.stringify({ 客户: 分.客户.length, 商机: 分.商机.length, 计划和待办: 分.计划.length + 分.待办.length, 线索: 分.线索.length, 渠道: 分.渠道.length, 项目: 分.项目.length }),
      },
    });
    await tx.user.update({ where: { id }, data: { active: false } });
    return { 分, 交接: h.id };
  }, { timeout: 30_000 });
  await 撤托管成员(id);

  const [被停, 接手] = await Promise.all([
    prisma.user.findUnique({ where: { id }, select: { name: true } }),
    prisma.user.findUnique({ where: { id: transferToId }, select: { name: true } }),
  ]);
  const 进公海 = 分.进公海客户.length + 分.本来在公海.length;
  await recordAudit({
    user: me, action: "deactivate", entity: "User", entityId: id,
    summary: `停用成员「${被停?.name ?? id}」，交接给「${接手?.name ?? transferToId}」，等对方确认后转过去：` +
      `${分.客户.length} 位客户、${分.商机.length} 个进行中商机、${分.计划.length + 分.待办.length} 条没完成的计划和待办、` +
      `${分.线索.length} 条线索、${分.渠道.length} 个渠道` + (分.项目.length ? `、${分.项目.length} 个项目` : "") +
      (方式 === "公海" ? `；${进公海} 位客户已放进公海` + (分.进公海项目.length ? `、${分.进公海项目.length} 个项目已放回项目公海` : "") : ""),
    detail: { userId: id, transferToId, 方式, 交接, 交接中: true, 进公海客户: 分.进公海客户, 进公海项目: 分.进公海项目 },
  });

  revalidatePath("/settings");
  revalidatePath("/customers");
  revalidatePath("/projects");
  return { ok: true as const, 交接中: true as const };
}

/** 一次最多停用多少人：和离职交接「200 条一次做完」同一个量 */
const 批量停用上限 = 200;

/**
 * 批量离职（企业版 D-36）：同一个接手人、同一种交接方式，一个个停用，各自一笔事务。
 * 先看每个人都办得了再动手，不会停到一半才发现有人没权限；单个人失败（比如接手人刚好在里面）记下来接着办别人
 */
export async function 批量停用(ids: string[], transferToId: string, 方式: 停用方式 = "转交") {
  if (!企业版()) {
    await requireAdmin();
    return { ok: false as const, error: "批量离职是企业版的功能" };
  }
  const 们 = Array.isArray(ids) ? [...new Set(ids.filter((x) => typeof x === "string" && x))] : [];
  if (!们.length) return { ok: false as const, error: "先选要停用的成员" };
  if (们.length > 批量停用上限) return { ok: false as const, error: `一次最多停用 ${批量停用上限} 人` };
  if (们.includes(transferToId)) return { ok: false as const, error: "接手人不能在要停用的人里" };
  for (const id of 们) await 能办离职(id);
  const 失败: { id: string; error: string }[] = [];
  let 交接中 = 0;
  for (const id of 们) {
    const r = await deactivateUser(id, transferToId, 方式).catch((e) => {
      console.error("批量停用失败：", id, e);
      return { ok: false as const, error: "停用没成功，刷新再试" };
    });
    if (!r.ok) 失败.push({ id, error: r.error });
    else if ("交接中" in r) 交接中++;
  }
  // 交接中只在有的时候给（规则关着、不是企业版时返回值和原来一样）
  return { ok: true as const, 停了: 们.length - 失败.length, 失败, ...(交接中 ? { 交接中 } : {}) };
}

/**
 * 停用前清点（离职交接对话框用，企业版才有）：两种方式各会转走、放进公海多少，和停用时同一套分法（停用分拣）。
 * 只是数个数，真停用时在事务里重新分。不是企业版对话框照原来的说，不来清点
 */
export async function 停用清点(id: string) {
  await 能办离职(id);
  if (typeof id !== "string" || !id) return { ok: false as const, error: "这个成员已不存在，请刷新重试" };
  if (!企业版()) return { ok: false as const, error: "离职交接是企业版的功能" };
  const 数 = (分: Awaited<ReturnType<typeof 停用分拣>>) => ({
    客户: 分.客户.length,
    进公海客户: 分.进公海客户.length + 分.本来在公海.length,
    项目: 分.项目.length,
    进公海项目: 分.进公海项目.length,
    订单项目: 分.订单项目,
  });
  const [转交, 公海] = await Promise.all([停用分拣(prisma, id, "转交", true), 停用分拣(prisma, id, "公海", true)]);
  return { ok: true as const, 转交: 数(转交), 公海: 数(公海) };
}

export async function reactivateUser(id: string) {
  const me = await requireAdmin();
  const u = typeof id === "string" && id ? await prisma.user.findUnique({ where: { id } }) : null;
  if (!u) return { ok: false as const, error: "这个成员已不存在，请刷新重试" };
  if (u.active) return { ok: true as const };
  // 企业版「交接中」：人回来了，还没确认的离职交接作废（不然接手人之后一确认，在职的人名下的东西被转走）
  const 在交接 = 企业版() ? await 离职交接中(id) : null;
  if (在交接) await 了结(prisma, 在交接.id, "已撤回", me.id);
  // 托管版：停用时撤掉的成员资格要加回来，否则他登录会被告知「没有工作区」
  if (托管版()) {
    const t = await resolveCurrentTenant();
    const link = await prisma.workspaceAccount.findFirst({ where: { userId: id } });
    if (!t || !link) return { ok: false as const, error: "无法恢复成员的登录资格，请刷新重试或联系管理员" };
    try {
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id }, data: { active: true } });
        await 复成员(link.accountId, t.workspaceId, u.role);
      });
    } catch (error) {
      console.error("恢复托管成员失败：", error);
      return { ok: false as const, error: "成员恢复失败，仍保持停用，请稍后重试" };
    }
  } else {
    await prisma.user.update({ where: { id }, data: { active: true } });
  }
  await recordAudit({
    user: me, action: "reactivate", entity: "User", entityId: id,
    summary: `恢复成员「${u.name}」`,
  });
  revalidatePath("/settings");
  return { ok: true as const };
}

/**
 * 改自己的名字和职位。**任何人都可以改自己的**——不需要管理员。
 *
 * 在这之前，改名只存在于「团队成员 → 编辑成员」那个弹窗里，而那个弹窗只有管理员打得开：
 * 一个销售想把自己的名字从邮箱前缀改成中文名，得去求管理员。
 * 名字不是权限，是称呼——它出现在左下角、在每一条跟进的署名上、在业绩榜上。
 *
 * 登录名（email 那一列）**不在这里改**：它同时是控制面账号的标识，
 * 改一边不改另一边就登不进来（见 saveUser 里那段注释）。
 */
export async function 改我的资料(input: { name: string; title: string }) {
  const me = await requireUser();
  if (await 是共享区()) return { ok: false as const, error: "这是几个试用团队共用的账号，名字和密码不能改——改了别的团队就登不进来了" };
  const name = input.name.trim();
  const title = input.title.trim();
  if (!name) return { ok: false as const, error: "名字不能为空" };
  if (name.length > 20) return { ok: false as const, error: "名字最多 20 个字" };
  if (title.length > 20) return { ok: false as const, error: "职位最多 20 个字" };

  const 旧 = await prisma.user.findUnique({ where: { id: me.id }, select: { name: true, title: true } });
  if (!旧) return { ok: false as const, error: "用户不存在" };
  if (旧.name === name && 旧.title === title) return { ok: true as const };

  await prisma.user.update({ where: { id: me.id }, data: { name, title } });
  await recordAudit({
    user: me, action: "update", entity: "User", entityId: me.id,
    summary: `改了自己的资料：${旧.name}${旧.title ? `（${旧.title}）` : ""} → ${name}${title ? `（${title}）` : ""}`,
    detail: { from: { name: 旧.name, title: 旧.title }, to: { name, title } },
  });
  // 桌面端登录着云端：云端账号名一起改（手机「我的」、授权框、运营台显示它）。推不上不拦，下次建团队 / 登录时再对
  if (本地模式() && 旧.name !== name && 读云端凭据()?.token && (await 本机我(prisma))?.id === me.id) await 云端跟着改名(调云, name).catch(() => false);
  // 名字出现在左栏、署名、业绩榜上，改完整站都要跟着变
  revalidatePath("/", "layout");
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
  /*
    网页试用版是几个团队共用一个账号（memory: web-trial-shared-workspace）。原来这里不拦：
    任何一个团队改了密码，会吊销这个账号的全部会话，别的团队全被踢出、也登不回来（2026-10-01 排查 A3）
  */
  if (await 是共享区()) return { ok: false as const, error: "这是几个试用团队共用的账号，名字和密码不能改——改了别的团队就登不进来了" };
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

const 是网址 = (s: string) => /^https?:\/\//.test(s.trim());

/**
 * 本机的设置（AI 接入、MCP、自动判断）：桌面端本地模式下是这台电脑主人自己的，不同步给团队，
 * 团队版的业务员（SALES）在自己电脑上也能改（2026-10-04 两档权限）。网页版 / 托管版照旧只有管理员
 */
async function 能改本机设置() {
  const me = await requireUser();
  if (process.env.DESKTOP_LOCAL === "1") return me;
  return requireAdmin();
}
const 本机说了算 = (role: string) => role === "ADMIN" || process.env.DESKTOP_LOCAL === "1";

/**
 * 保存 AI 接入配置。只有管理员能改；日志只记"改了"，不记任何值——
 * 地址与模型名无所谓，但同一条日志里不能出现 key，哪怕是尾号。
 */
export async function saveLlmSettings(input: { baseUrl: string; model: string; apiKey?: string | null; options?: ModelOption[] }) {
  const me = await 能改本机设置();
  if (!是网址(input.baseUrl)) return { ok: false as const, error: "接口地址要以 http:// 或 https:// 开头" };
  if (!input.model.trim()) return { ok: false as const, error: "请填写模型名" };
  await saveLlmConfig(input);
  await recordAudit({ user: me, action: "update", entity: "Setting", entityId: "llm", summary: "修改了 AI 接入配置" });
  revalidatePath("/", "layout");
  return { ok: true as const };
}

export async function clearLlmSettings() {
  const me = await 能改本机设置();
  await clearLlmConfig();
  await recordAudit({ user: me, action: "update", entity: "Setting", entityId: "llm", summary: "清除了界面里的 AI 接入配置" });
  revalidatePath("/", "layout");
  return { ok: true as const };
}

/** 用表单里当前填的值发一次最小请求；key 留空则用已保存的 */
export async function testLlmSettings(input: { baseUrl: string; model: string; apiKey?: string | null }) {
  await 能改本机设置();
  if (!是网址(input.baseUrl)) return { ok: false as const, error: "接口地址要以 http:// 或 https:// 开头" };
  const cfg = await resolveLlmConfigForTest(input);
  if (!cfg) return { ok: false as const, error: "还没有 API Key：请先填写" };
  return testLlm(cfg);
}

/* ---------- 业务配置 ---------- */

export async function saveBusinessSettings(cfg: BusinessConfig) {
  const me = await requireAdmin();
  const merged = mergeBusiness(cfg);
  const 状态错误 = Object.values(状态名问题(merged))[0];
  if (状态错误) return { ok: false as const, error: 状态错误 };
  const 阶段错误 = Object.values(阶段名问题(merged))[0];
  if (阶段错误) return { ok: false as const, error: 阶段错误 };
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
  // 切到外贸：给老客户补一次来源（渠道 / 线索上的），外贸模版不摆渠道（lib/customer-extra-db.ts 补来源）
  const 补了来源 = before.template !== "trade" && merged.template === "trade" ? await 补来源() : 0;
  if (补了来源) {
    await recordAudit({ user: me, action: "update", entity: "Customer", entityId: "business", summary: `切到外贸模版：${补了来源} 位${merged.customer}的来源从渠道 / 线索补进了外贸档案` });
  }
  revalidatePath("/", "layout");
  return { ok: true as const, 补了来源 };
}

const BUSINESS_FIELD_LABELS: Record<keyof BusinessConfig, string> = {
  brief: "业务简介", customer: "核心名词", fields: "档案字段名", grades: "年级选项", sources: "线索来源", industries: "行业选项", statusLabels: "状态显示名", stageLabels: "商机阶段名",
  template: "模版", currency: "本位币", poolDays: "自动放进公海", projectMode: "项目模式",
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

/* ---------- MCP 接入 ---------- */

/**
 * 让别人的 agent 连进来查这个 CRM（Claude Code / Codex / Claude 桌面端）。
 *
 * 这是我们**唯一**一处「反过来」的接口：平时是我们去调模型，这条是别人来调我们。
 * 对一人公司那个人群最有用——他多半已经在付 Claude 或 ChatGPT 的钱，
 * 用自己的订阅和 agent 来问自己的客户本，数据一步不出本机。
 *
 * 令牌在这里明着回给管理员：它是本机的一把钥匙，而这一页只有管理员进得来。
 * 「只显示一次」在这里帮倒忙——人复制到一半被打断，就只剩「重新生成」一条路，
 * 而重新生成会把已经配好的客户端全部踢下线。
 */
export async function 查MCP接入(): Promise<{
  可用: boolean;
  已开: boolean;
  地址: string;
  令牌: string | null;
}> {
  const me = await requireUser();
  const 可用 = !multiTenant();
  if (!可用 || !本机说了算(me.role)) return { 可用: false, 已开: false, 地址: "", 令牌: null };
  const t = await 读令牌();
  return { 可用: true, 已开: Boolean(t), 地址: MCP地址(), 令牌: t?.token ?? null };
}

export async function 开启MCP(): Promise<{ ok: true; 令牌: string; 地址: string } | { ok: false; error: string }> {
  const me = await requireUser();
  if (multiTenant()) return { ok: false, error: "托管版不提供 MCP 接口" };
  if (!本机说了算(me.role)) return { ok: false, error: "只有管理员能开这个口子" };
  const t = await 生成令牌(me.id);
  await recordAudit({ user: me, action: "update", entity: "Setting", entityId: "mcpToken", summary: "生成了 MCP 接入令牌（旧的同时作废）" });
  return { ok: true, 令牌: t.token, 地址: MCP地址() };
}

export async function 关闭MCP(): Promise<{ ok: boolean }> {
  const me = await requireUser();
  if (multiTenant() || !本机说了算(me.role)) return { ok: false };
  await 撤销令牌();
  await recordAudit({ user: me, action: "update", entity: "Setting", entityId: "mcpToken", summary: "关掉了 MCP 接入（令牌已撤销）" });
  return { ok: true };
}

/* ---------- 导入时让 AI 认列（判断类模型；存储和函数名还叫「自动判断」） ---------- */
/**
 * 开着时导入第 1 步多一颗「让 AI 认一下」，人点了才发（2026-10-04 L-076，原来是读完表就自动发）。默认关。
 *
 * 没配 JEV_API_KEY 的部署（自部署的开源版多半如此）一律「不可用」，界面上不摆这个开关：
 * 摆一个关了也没区别的开关，只会让人以为自己关掉了什么。
 */
export async function 查自动判断(): Promise<{ 可用: boolean; 已开: boolean }> {
  const me = await requireUser();
  if (!判断可用() || !本机说了算(me.role)) return { 可用: false, 已开: false };
  return { 可用: true, 已开: await 自动判断开着() };
}

export async function 设自动判断开关(开: boolean): Promise<void> {
  const me = await requireUser();
  if (!本机说了算(me.role)) throw new Error("只有管理员能改");
  /*
    共享试用区一律不许改（2026-10-04，回归核对 H-037）：那儿的「管理员」是好几个团队共用的一套账号，
    开了它导入时就能把表头和前三行发给 AI——这个开关不能让别的团队替你打开
  */
  if (await 是共享区()) throw new Error("FORBIDDEN");
  await 设自动判断(开);
  await recordAudit({
    user: me, action: "update", entity: "Setting", entityId: "assist",
    summary: 开 ? "打开了「导入时让 AI 认列」" : "关掉了「导入时让 AI 认列」",
  });
}
