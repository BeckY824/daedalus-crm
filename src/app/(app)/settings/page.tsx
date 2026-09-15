import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import SettingsView from "./SettingsView";
import { describeLlmConfig } from "@/lib/llm";
import { getBusiness } from "@/lib/business";
import { aiUsageThisMonth } from "@/lib/ai-usage";
import { multiTenant } from "@/lib/tenant/context";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const me = await requireUser();

  // 操作日志只增不删，长期会很大，这里只取最近 200 条给人翻
  const logs = await prisma.auditLog.findMany({
    orderBy: { at: "desc" },
    take: 200,
  });

  const [llm, business, aiUsage] = await Promise.all([describeLlmConfig(), getBusiness(), aiUsageThisMonth()]);

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      _count: { select: { salesCustomers: true, opportunities: true, followUps: true } },
    },
  });

  return (
    <SettingsView
      me={me}
      isAdmin={me.role === "ADMIN"}
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
