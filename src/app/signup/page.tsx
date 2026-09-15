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
 * 自助注册没有发码通道时，这一页跳去官网的咨询页，
 * 由客户发邮件过来、我们在运营台手动开号。去掉 SIGNUP_REDIRECT 就回到自助注册。
 */
/**
 * `?from=desktop`：桌面端登录窗里点「注册新账号」开浏览器过来的。
 * 注册完不能把人丢进网页版——他要回桌面端登录，网页版对他是个岔路。
 */
export default async function SignupPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const to = process.env.SIGNUP_REDIRECT?.trim();
  if (to) redirect(to);
  const { from } = await searchParams;
  return <SignupForm 注册赠送={注册赠送} 要验证码={await 注册要验证码()} 来自桌面端={from === "desktop"} />;
}
