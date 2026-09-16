import { redirect } from "next/navigation";
import SignupForm from "./SignupForm";
import { 注册赠送 } from "@/lib/tenant/ai-allowance";
import { 注册要验证码 } from "./actions";

/**
 * 必须动态渲染：跳不跳取决于运行时的 SIGNUP_REDIRECT，而这一页默认会被
 * 预渲染成静态页——那样构建时没设这个变量，容器里再设也不会跳，
 * 表现是「关了自助注册但注册表单照样打得开」。
 */
export const dynamic = "force-dynamic";

/**
 * 注册只开云端账号，不开工作区（2026-09-16）。它服务的是桌面端：
 * 桌面端本地模式必须先登录云端账号，而注册只有网页这一条路（见 desktop/main.js 顶部）。
 * 所以不管从哪来，注册完的目的地都是桌面端，`?from=desktop` 不再需要区分。
 *
 * 想彻底关掉注册就设 SIGNUP_REDIRECT——但要清楚代价：关了它，
 * 新用户装完桌面端就开不了账号，本地模式进不去。
 */
export default async function SignupPage() {
  const to = process.env.SIGNUP_REDIRECT?.trim();
  if (to) redirect(to);
  return <SignupForm 注册赠送={注册赠送} 要验证码={await 注册要验证码()} />;
}
