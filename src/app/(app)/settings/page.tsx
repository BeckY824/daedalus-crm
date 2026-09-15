import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import SettingsView from "./SettingsView";
import { describeLlmConfig } from "@/lib/llm";
import { getBusiness } from "@/lib/business";
import { aiUsageThisMonth } from "@/lib/ai-usage";
import { multiTenant } from "@/lib/tenant/context";
import { 当前是演示区 } from "@/lib/demo/current";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const me = await requireUser();

  // 操作日志只增不删，长期会很大，这里只取最近 200 条给人翻
  const logs = await prisma.auditLog.findMany({
    orderBy: { at: "desc" },
    take: 200,
  });

  const [llm, business, aiUsage, 演示区] = await Promise.all([describeLlmConfig(), getBusiness(), aiUsageThisMonth(), 当前是演示区()]);

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
       * 演示区里这个人是 ADMIN（他得能演示管理员看到的东西），但演示区进门
       * 不要账号也不要密码——「管理员」在那里等于「任何人」。服务端已经不给他
       * 过 requireAdmin 了（settings/actions.ts），界面这边也别摆那些按钮：
       * 摆着点了只会报错，而 AI 接入那一栏还会把平台 Key 的尾 4 位显示出来。
       */
      isAdmin={me.role === "ADMIN" && !演示区}
      /* 托管版的登录标识是邮箱（控制面账号按邮箱认，找回密码也靠它）；
         自部署版是用户名，既有账号是 admin / zhangsan 这种，不能改 */
      用邮箱登录={multiTenant()}
      llm={llm}
      business={business}
      aiUsage={aiUsage}
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
