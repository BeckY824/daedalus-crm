import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import SettingsView from "./SettingsView";
import { 我的机器 } from "./actions";
import { 本地模式, 读 as 读云端凭据 } from "@/lib/desktop/cloud";
import { describeLlmConfig } from "@/lib/llm";
import { getBusiness } from "@/lib/business";
import { aiUsageThisMonth } from "@/lib/ai-usage";
import { multiTenant } from "@/lib/tenant/context";
import { 当前是共享区 } from "@/lib/shared-ws/current";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
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

  return (
    <SettingsView
      me={me}
      /**
       * 共享工作区里这个人是 ADMIN（他得能展示管理员看到的东西），但那套账号密码
       * 发给了多个团队——「管理员」在那里等于「拿到过密码的任何人」。服务端已经
       * 不给他过 requireAdmin 了（settings/actions.ts），界面这边也别摆那些按钮：
       * 摆着点了只会报错，而 AI 接入那一栏还会把平台 Key 的尾 4 位显示出来。
       */
      isAdmin={me.role === "ADMIN" && !共享区}
      /* 托管版的登录标识是邮箱（控制面账号按邮箱认，找回密码也靠它）；
         自部署版是用户名，既有账号是 admin / zhangsan 这种，不能改 */
      用邮箱登录={multiTenant()}
      llm={llm}
      business={business}
      aiUsage={aiUsage}
      机器={机器}
      桌面端={桌面端}
      logs={logs.map((l) => ({
        id: l.id,
        at: l.at.toISOString(),
        userName: l.userName,
        action: l.action,
        entity: l.entity,
        summary: l.summary,
        detail: l.detail,
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
