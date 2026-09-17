import Link from "next/link";
import { Typography } from "antd";
import Logo from "@/components/Logo";
import ForgotForm from "./ForgotForm";
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
  if (本地模式()) {
    if ((await 策略()).reset) return <ForgotForm />;
  } else if (能找回密码()) {
    return <ForgotForm />;
  }

  /**
   * 通道没配好（或者这是自部署版）时不画表单。
   * 画一个填了没反应的表单，比直说「这条路现在走不通」更糟：
   * 人会一直等一封永远不会来的信。
   */
  return (
    <div className="login-shell">
      <div className="login-card">
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <div className="login-mark">
            <Logo size={30} />
          </div>
          <Typography.Title level={4} style={{ margin: 0, letterSpacing: -0.4 }}>
            找回密码
          </Typography.Title>
        </div>
        <Typography.Paragraph type="secondary" style={{ fontSize: 13, textAlign: "center", marginBottom: 0 }}>
          这个部署还没开通自助找回。
          <br />
          自部署版请找你的管理员在「设置管理 → 用户管理」里重置；
          <br />
          用我们托管版的请联系我们，我们人工帮你重置。
        </Typography.Paragraph>
        <div style={{ textAlign: "center", marginTop: 18, fontSize: 13 }}>
          <Link href="/login">返回登录</Link>
        </div>
      </div>
    </div>
  );
}
