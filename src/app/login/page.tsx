import { redirect } from "next/navigation";
import LoginForm from "./LoginForm";
import { 能找回密码 } from "@/lib/tenant/password-reset";
import { multiTenant } from "@/lib/tenant/context";
import { 自助注册已关闭 } from "@/lib/tenant/signup-policy";
import { 本地模式, 读 as 读云端凭据, 策略, 云端地址 } from "@/lib/desktop/cloud";

/**
 * 必须动态渲染：要不要画「忘记密码」取决于运行时的 MULTI_TENANT 和 SMTP_*。
 * 默认会被预渲染成静态页，那样构建时是什么样，容器里就永远是什么样。
 */
export const dynamic = "force-dynamic";

/** 站在登录页上的原因，壳或路由带过来的。有就在表单上方说清，别让人猜自己怎么被退出的 */
const 原因文案: Record<string, string> = {
  revoked:
    "这台机器的云端登录已经失效：要么账号改过密码（改密码会让所有机器退出），要么在网页端的「已登录的机器」里退出了这一台。本机数据不受影响，重新登录就能接着用。",
  noadmin: "本机数据库里没有管理员账号，登录进不去。请从「帮助 → 反馈问题」告诉我们。",
  changed: "密码已经改好了。改密码会让所有已登录的机器退出，这一台也在内——用新密码重新登录就行，本机数据不受影响。",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const sp = await searchParams;

  /**
   * 桌面端本地模式：这一页就是**云端账号**的门（2026-09-17 起桌面端只有这一套身份）。
   * 手上有令牌的人不该停在这里——走自动登录那条路，和壳启动时同一个路由。
   * 画哪几个入口由云端说了算：注册收不收、能不能自助找回，问一次 /api/account/policy。
   */
  if (本地模式()) {
    if (读云端凭据() && process.env.DESKTOP_TOKEN && !sp.reason) {
      redirect(`/api/desktop/session?t=${encodeURIComponent(process.env.DESKTOP_TOKEN)}`);
    }
    const p = await 策略();
    return (
      <LoginForm
        桌面端
        用邮箱
        可找回密码={p.reset}
        可注册={p.register}
        注册地址={`${云端地址()}/signup?from=desktop`}
        提示={sp.reason ? 原因文案[sp.reason] : undefined}
      />
    );
  }

  /*
    登录框那一格叫什么，取决于这个部署里账号长什么样：
      托管版  —— 注册就是邮箱验证码开的号，只有邮箱（设计稿 20/AUTH：登录统一使用邮箱）
      自部署  —— 管理员在设置里建的成员，登录名是 admin、zhangsan 这样的用户名
    写死一个的话，另一半人会对着一个填不进去的框反复试。
  */
  return (
    <LoginForm
      可找回密码={能找回密码()}
      用邮箱={multiTenant()}
      /* 注册入口两端一致（2026-09-20）。托管版才有自助注册这回事：
         自部署的成员是管理员在设置里建的，那儿没有注册这条路。
         关掉自助注册（SIGNUP_REDIRECT）时这个入口跟着消失，和桌面端问 policy 得到的答案同源。 */
      可注册={multiTenant() && !自助注册已关闭()}
      注册地址="/signup"
    />
  );
}
