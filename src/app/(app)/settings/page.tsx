import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import SettingsView from "./SettingsView";
import { describeLlmConfig } from "@/lib/llm";
import { getBusiness } from "@/lib/business";
import { aiUsageThisMonth } from "@/lib/ai-usage";

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
