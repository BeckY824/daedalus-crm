import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { multiTenant } from "@/lib/tenant/context";
import { demoSlug } from "@/lib/demo/config";
import { 演示码剩余 } from "@/lib/tenant/activation";
import { 演示访客Cookie } from "@/lib/tenant/ai-allowance";
import DemoGate from "./DemoGate";

export const dynamic = "force-dynamic";

/**
 * 演示区门口：要一个演示码。
 * 没配 DEMO_WORKSPACE 就是 404——自部署版不该凭空多出一个免登录入口。
 * 这个浏览器已经绑过码的，给一个「继续进入」，不用再输。
 */
export default async function DemoPage() {
  if (!multiTenant() || !demoSlug()) notFound();
  const visitor = (await cookies()).get(演示访客Cookie)?.value ?? null;
  const 已绑 = visitor ? await 演示码剩余(visitor) : null;
  return <DemoGate 已绑={已绑 ? { 还剩: 已绑.还剩 } : null} />;
}
