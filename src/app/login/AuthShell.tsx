import { PixelLogo } from "@/components/Logo";
import AuthSide, { type 门口 } from "./AuthSide";

/**
 * 网页版几扇门（注册、找回密码、找回不了时那张说明）的外壳：左栏品牌、右边一张表。
 * 和桌面端 DesktopAuth / DesktopForgot 同一套样子（2026-10-04 起），表单本身各管各的。
 */
export default function AuthShell({ 门, 标题, 说明, children }: { 门: 门口; 标题: React.ReactNode; 说明?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="auth">
      <AuthSide 门={门} />
      <main className="auth-main">
        <div className="auth-form">
          <div className="auth-mobile-mark" aria-hidden>
            <PixelLogo size={40} />
          </div>
          <div className="auth-step">
            <h1>{标题}</h1>
            {说明 && <p className="auth-hint">{说明}</p>}
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
