import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import SettingsView from "./SettingsView";
import { 我的机器 } from "./actions";
import { 本地模式, 读 as 读云端凭据 } from "@/lib/desktop/cloud";
import { describeLlmConfig } from "@/lib/llm";
import { getBusiness } from "@/lib/business";
import { 角色字典, 异常类别字典, 能进公海的阶段 } from "@/lib/project/db";
import { 读组织规则 } from "@/lib/project/org-rules-store";
import { 读卡点默认 } from "@/lib/project/blocker";
import { 企业版 } from "@/lib/enterprise/switch";
import { aiUsageThisMonth } from "@/lib/ai-usage";
import { multiTenant } from "@/lib/tenant/context";
import { 当前是共享区 } from "@/lib/shared-ws/current";
import { 规则开着, 规则名们 } from "@/lib/enterprise/rules";
import { 文字里号码打码 } from "@/lib/utils";
import { 读组织, 直属上级of, 虚线上级of, 管理员类别of } from "@/lib/enterprise/org";
import { 规整字段配置, 字段权限key } from "@/lib/enterprise/field-perm";
import { getSetting } from "@/lib/settings";
import { 读改权限, 能改设置, 谁能改的话, type 设置项名 } from "@/lib/enterprise/edit-perm";
import type { 组织架构 } from "./OrgTab";
import { 本月分配情况 } from "../leads/assign-actions";

/**
 * 设置的正文（服务端组件，负责取数）。**两条路由共用它**：
 *   /settings                  —— 整页（刷新、深链、桌面端菜单 ⌘, 走这条）
 *   @modal/(.)settings         —— 应用内点开时把同一份正文装进浮层（Next 的拦截路由）
 * 取数只写一遍，两边永远一致。
 */
export default async function SettingsBody() {
  const me = await requireUser();

  // 操作日志只增不删，长期会很大，这里只取最近 200 条给人翻
  const logs = await prisma.auditLog.findMany({
    orderBy: { at: "desc" },
    take: 200,
  });

  /**
   * 机器那一栏：托管版里用这个账号登录过桌面端的机器。
   * 自部署版和共享工作区拿到的是 null，界面上那一栏整个不出现（见 actions.ts 的 我的控制面账号）。
   */
  const [llm, business, aiUsage, 共享区, 机器] = await Promise.all([
    describeLlmConfig(), getBusiness(), aiUsageThisMonth(), 当前是共享区(), 我的机器(),
  ]);
  /**
   * 桌面端本地模式才有的一栏：账号、备份、更新。网页版传 null，整栏不出现。
   * 余额直接用 describeLlmConfig 刚问过的那一次（它在本地模式下就是去云端问的），
   * 不再单独问第二遍——这一页每次打开去云端一趟就够了。
   */
  const 云端 = 本地模式() ? 读云端凭据() : null;
  const 桌面端 = 云端 ? { 账号: 云端.contact || 云端.name, 余额: llm.source === "cloud" ? (llm.credits ?? null) : null } : null;

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      _count: { select: { salesCustomers: true, opportunities: true, followUps: true } },
    },
  });

  // 项目模式（团队版 1a）开着才多一栏：组员角色字典、异常类别字典
  const 项目设置底 = business.projectMode
    ? await Promise.all([
        角色字典(),
        prisma.projectMember.groupBy({ by: ["roleId"], _count: { _all: true } }),
        异常类别字典(),
        prisma.project.groupBy({ by: ["exceptionCategoryId"], where: { exceptionCategoryId: { not: null } }, _count: { _all: true } }),
        // 组织规则只企业版有：别的版本不读、卡片不出
        企业版() ? 读组织规则() : null,
        企业版() ? 读卡点默认() : null,
        // 每人手上的线索 / 商机项目数，和 lib/project/db.ts 持有数 同一个口径
        !企业版() ? [] : prisma.project.groupBy({ by: ["ownerId"], where: { pooledAt: null, result: null, phase: { in: [...能进公海的阶段] } }, _count: { _all: true } }),
      ]).then(([角色, 用量, 类别, 类别用量, 组织规则, 卡点默认, 持有]) => {
        const 用 = new Map(用量.map((x) => [x.roleId, x._count._all]));
        const 类别用 = new Map(类别用量.map((x) => [x.exceptionCategoryId, x._count._all]));
        return {
          角色们: 角色.map((r) => ({ id: r.id, name: r.name, active: r.active, 用的人: 用.get(r.id) ?? 0 })),
          类别们: 类别.map((c) => ({ id: c.id, name: c.name, active: c.active, 用的人: 类别用.get(c.id) ?? 0 })),
          组织规则,
          卡点默认,
          持有: Object.fromEntries(持有.map((x) => [x.ownerId, x._count._all])),
        };
      })
    : null;

  // 企业版才多一栏「组织架构」：部门树、每个人的部门 / 角色 / 业务线 / 上级。老板和总管理员能改（字段权限、谁能改按「后台设置谁能改」）
  const [org, 开关, 字段权限, 线索分配, 改权限] = 企业版()
    ? await Promise.all([
        读组织(),
        Promise.all(规则名们.map(async (n) => [n, await 规则开着(n)] as const)).then((xs) => Object.fromEntries(xs) as Record<(typeof 规则名们)[number], boolean>),
        getSetting<unknown>(字段权限key).then(规整字段配置),
        // 「线索分配」规则关着时是 null，那一块不出现
        本月分配情况(),
        读改权限(),
      ])
    : [null, null, null, null, null];
  /**
   * 每样后台设置这个人能不能改：null = 能改，否则是挡住的那句（卡片右上角显示，控件灰掉）。
   * 企业版按「后台设置谁能改」表（B2 第 6 条），别的版本照旧只有老板。和服务端 挡改设置 同一套。
   */
  const 挡 = (项: 设置项名): string | null =>
    共享区 ? "共享试用区不能改"
    : org && 改权限 ? (能改设置(org, me, 项, 改权限) ? null : 谁能改的话(改权限, 项))
    : me.role === "ADMIN" ? null : "只有老板能改";
  const 项目设置 = 项目设置底 && {
    ...项目设置底,
    挡: { 字典: 挡("字典"), 持有上限: 挡("持有上限"), 节点时限: 挡("节点时限"), 必填字段: 挡("必填字段") },
  };
  const 组织架构: 组织架构 | null = org && 开关 && 字段权限 && 改权限
    ? (() => {
        const 名 = new Map(users.map((u) => [u.id, u.name]));
        return {
          部门: [...org.部门.values()],
          成员: users.filter((u) => org.成员.has(u.id)).map((u) => {
            const m = org.成员.get(u.id)!;
            // 显式指定的上级停用了，直属上级of 会退回按部门推；界面上也当没指定，显示推出来的那位
            const 指定 = m.managerId && org.成员.has(m.managerId) ? m.managerId : null;
            const 自动 = 指定 ? null : 直属上级of(org, u.id);
            return {
              id: u.id, name: u.name, deptId: m.deptId, bizRole: m.bizRole, line: m.line,
              managerId: 指定, dottedManagerId: 虚线上级of(org, u.id),
              自动上级: 自动 ? 名.get(自动) ?? null : null,
            };
          }),
          能改: !共享区 && (me.role === "ADMIN" || 管理员类别of(org, me.id) === "总管理员"),
          是老板: me.role === "ADMIN" && !共享区,
          规则开着: 开关,
          字段权限,
          字段权限挡: 挡("字段权限"),
          改权限,
          线索分配: 线索分配?.length ? 线索分配 : null,
        };
      })()
    : null;
  // 企业版：直属上级能给下属办离职（D-36），管理员除外；老板本来就能办全部。跟「按组织看客户」开关走，同 能办离职
  const 下属可停用 = org && 开关?.按组织看客户 && !共享区 && me.role !== "ADMIN"
    ? users.filter((u) => u.role !== "ADMIN" && 直属上级of(org, u.id) === me.id).map((u) => u.id)
    : [];

  return (
    <SettingsView
      项目设置={项目设置}
      组织架构={组织架构}
      me={me}
      /**
       * 共享工作区里这个人是 ADMIN（他得能展示管理员看到的东西），但那套账号密码
       * 发给了多个团队——「管理员」在那里等于「拿到过密码的任何人」。服务端已经
       * 不给他过 requireAdmin 了（settings/actions.ts），界面这边也别摆那些按钮：
       * 摆着点了只会报错，而 AI 接入那一栏还会把平台 Key 的尾 4 位显示出来。
       */
      isAdmin={me.role === "ADMIN" && !共享区}
      共享区={共享区}
      企业版导入={企业版() && me.role === "ADMIN" && !共享区}
      /* 托管版的登录标识是邮箱（控制面账号按邮箱认，找回密码也靠它）；
         自部署版是用户名，既有账号是 admin / zhangsan 这种，不能改 */
      用邮箱登录={multiTenant()}
      企业版={企业版()}
      下属可停用={下属可停用}
      llm={llm}
      business={business}
      aiUsage={aiUsage}
      机器={机器}
      桌面端={桌面端}
      /* 共享试用区：留痕里记的是原号，别的团队也翻得到——号码在这儿打掉再交给浏览器（2026-10-01 排查 A5） */
      logs={logs.map((l) => ({
        id: l.id,
        at: l.at.toISOString(),
        userName: l.userName,
        action: l.action,
        entity: l.entity,
        summary: 共享区 ? 文字里号码打码(l.summary) : l.summary,
        detail: 共享区 && l.detail ? 文字里号码打码(l.detail) : l.detail,
      }))}
      users={users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        title: u.title,
        role: u.role,
        active: u.active,
        customerCount: u._count.salesCustomers,
        oppCount: u._count.opportunities,
        followCount: u._count.followUps,
      }))}
    />
  );
}
