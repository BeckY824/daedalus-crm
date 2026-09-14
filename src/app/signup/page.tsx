import { redirect } from "next/navigation";
import SignupForm from "./SignupForm";
import { 注册赠送 } from "@/lib/tenant/ai-allowance";

/**
 * 必须动态渲染：跳不跳取决于运行时的 SIGNUP_REDIRECT，而这一页默认会被
 * 预渲染成静态页——那样构建时没设这个变量，容器里再设也不会跳，
 * 表现是「关了自助注册但注册表单照样打得开」。
 */
export const dynamic = "force-dynamic";

/**
 * 自助注册没有发码通道时，这一页跳去官网的咨询页，
 * 由客户发邮件过来、我们在运营台手动开号。去掉 SIGNUP_REDIRECT 就回到自助注册。
 */
export default function SignupPage() {
  const to = process.env.SIGNUP_REDIRECT?.trim();
  if (to) redirect(to);
  return <SignupForm 注册赠送={注册赠送} />;
}
