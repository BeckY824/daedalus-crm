import { redirect } from "next/navigation";
import LoginForm from "./LoginForm";
import { 能找回密码 } from "@/lib/tenant/password-reset";
import { multiTenant } from "@/lib/tenant/context";

/**
 * 必须动态渲染：要不要画「忘记密码」取决于运行时的 MULTI_TENANT 和 SMTP_*。
 * 默认会被预渲染成静态页，那样构建时是什么样，容器里就永远是什么样。
 */
export const dynamic = "force-dynamic";

/**
 * 桌面端本地模式**根本不该停在这一页**。
 *
 * 那边的本机密码是建库时生成的一串随机字符，只写在数据目录的 `.init-password` 里——
 * 用户从没见过它，也没有「忘记密码」可点（本机跑的服务没有控制面、没有 SMTP，发不出信）。
 * 于是任何一条落到 /login 的路（在应用里点了「退出登录」、会话过期、手敲地址）
 * 都是把人锁在自己机器外面。
 *
 * 所以本地模式下这一页直接跳回自动登录那条路，和应用启动时走的是同一个路由。
 * `?fallback=1` 是**自动登录自己失败时**的退路（比如库里没有在职管理员），
 * 那时才真的画出表单，并告诉他密码在应用菜单里——否则这里会变成一个跳不出去的圈。
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ fallback?: string }> }) {
  const 本机 = process.env.DESKTOP_LOCAL === "1" && !!process.env.DESKTOP_TOKEN;
  const sp = await searchParams;
  if (本机 && !sp.fallback) redirect(`/api/desktop/session?t=${encodeURIComponent(process.env.DESKTOP_TOKEN!)}`);

  /*
    登录框那一格叫什么，取决于这个部署里账号长什么样：
      托管版  —— 注册就是邮箱验证码开的号，只有邮箱（设计稿 20/AUTH：登录统一使用邮箱）
      自部署  —— 管理员在设置里建的成员，登录名是 admin、zhangsan 这样的用户名
    写死一个的话，另一半人会对着一个填不进去的框反复试。
  */
  return <LoginForm 可找回密码={能找回密码()} 用邮箱={multiTenant()} 本机={本机} />;
}
