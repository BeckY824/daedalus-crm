import LoginForm from "./LoginForm";
import { 能找回密码 } from "@/lib/tenant/password-reset";

/**
 * 必须动态渲染：要不要画「忘记密码」取决于运行时的 MULTI_TENANT 和 SMTP_*。
 * 默认会被预渲染成静态页，那样构建时是什么样，容器里就永远是什么样。
 */
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  return <LoginForm 可找回密码={能找回密码()} />;
}
