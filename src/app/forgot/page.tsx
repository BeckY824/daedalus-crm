import Link from "next/link";
import AuthShell from "../login/AuthShell";
import { multiTenant } from "@/lib/tenant/context";
import ForgotForm from "./ForgotForm";
import DesktopForgot from "./DesktopForgot";
import { 能找回密码 } from "@/lib/tenant/password-reset";
import { 本地模式, 策略 } from "@/lib/desktop/cloud";

/**
 * 必须动态渲染：能不能自助找回取决于运行时的 MULTI_TENANT 和 SMTP_*，
 * 而这一页默认会被预渲染成静态页——那样构建时是什么样，容器里就永远是什么样，
 * 表现是「邮件通道配好了，找回密码页还写着请联系我们」。
 */
export const dynamic = "force-dynamic";

export default async function ForgotPage() {
  // 桌面端本地模式：账号在云端，能不能找回由云端说了算（动作那边也转调云端，见 actions.ts）
  // 桌面端：和登录页同一扇门（左栏一样，右边一步一屏），能不能找回由云端说了算
  if (本地模式()) return <DesktopForgot 可用={(await 策略()).reset} />;
  if (能找回密码()) {
    return <ForgotForm />;
  }

  /**
   * 通道没配好（或者这是自部署版）时不画表单。
   * 画一个填了没反应的表单，比直说「这条路现在走不通」更糟：
   * 人会一直等一封永远不会来的信。
   */
  /*
    原来这里写「设置管理 → 用户管理」，那个地方早就不叫这个名字了（排查 J-182）：现在是「设置 → 团队成员」
  */
  return (
    <AuthShell 门={multiTenant() ? "托管版" : "自部署"} 标题="找回密码" 说明="这个部署还没开通自助找回。">
      <p className="auth-alt">
        {multiTenant()
          ? "用我们托管版的，请从网页右上角「反馈」或官网联系我们，我们人工帮你重置。"
          : "请找你们的管理员，在「设置 → 团队成员」里帮你重置密码。"}
      </p>
      <p className="auth-alt">
        <Link href="/login">返回登录</Link>
      </p>
    </AuthShell>
  );
}
