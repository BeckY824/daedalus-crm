import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { multiTenant } from "@/lib/tenant/context";
import { demoSlug } from "@/lib/demo/config";
import { 演示剩余 } from "@/lib/tenant/demo-visitor";
import { 演示访客Cookie } from "@/lib/tenant/ai-allowance";
import DemoGate from "./DemoGate";

export const dynamic = "force-dynamic";

/**
 * 演示区门口。进门不要码了（整套码 2026-09-15 下线），但 AI 次数仍然按浏览器数。
 * 没配 DEMO_WORKSPACE 就是 404——自部署版不该凭空多出一个免登录入口。
 */
export default async function DemoPage() {
  if (!multiTenant() || !demoSlug()) notFound();
  const visitor = (await cookies()).get(演示访客Cookie)?.value ?? null;
  const 来过 = visitor ? await 演示剩余(visitor) : null;
  return <DemoGate 来过={来过 ? { 还剩: 来过.还剩 } : null} />;
}
