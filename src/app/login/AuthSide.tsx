import { PixelLogo } from "@/components/Logo";
import TypeBrand from "./TypeBrand";

/**
 * 桌面端门口的左栏：像素标 + 打字机名字、一句话、一段说清楚的小字。
 * 登录 / 注册（DesktopAuth）和找回密码（forgot/DesktopForgot）共用，两扇门长得一样。
 */
export default function AuthSide() {
  return (
    <aside className="auth-side">
      <div className="auth-mark">
        <PixelLogo size={96} />
        <TypeBrand />
      </div>
      <p className="auth-claim">客户、跟进、开发信，都在你自己的电脑上。</p>
      {/*
        **把拦得住和拦不住的都说出来**（原来在登录卡片底下，搬到这儿）。
        数据按云端账号分开存（desktop/accounts.js），换个账号登录看到的是他自己那一份；
        但同一个电脑账户下，拿 SQLite 工具直接打开对方的库文件，应用层分目录是拦不住的。
      */}
      <p className="auth-fine">
        数据只存在这台电脑上，账号只用来记 AI 次数。每个账号各存一份；同一个电脑账户下的人仍能翻到彼此的数据文件，要彻底分开请各用各的电脑账户。
      </p>
    </aside>
  );
}
