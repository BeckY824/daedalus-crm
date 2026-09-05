import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import AppShell from "@/components/AppShell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // JWT 有效但用户已被删除/停用时走这里：必须先清 Cookie 再回登录页，
  // 否则 proxy.ts 会把 /login 弹回 /dashboard 形成死循环。
  const user = await getCurrentUser();
  if (!user) redirect("/api/auth/logout");

  // 顶栏铃铛：我名下未完成的待办
  const pendingCount = await prisma.task.count({
    where: { ownerId: user.id, done: false },
  });

  return (
    <AppShell user={user} pendingCount={pendingCount}>
      {children}
    </AppShell>
  );
}
