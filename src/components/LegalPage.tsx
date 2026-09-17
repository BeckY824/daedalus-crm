import Link from "next/link";
import Logo from "@/components/Logo";
import LegalBody from "@/components/LegalBody";

/**
 * 条款页的壳：用户协议、隐私政策共用。
 *
 * 不进 antd，不进应用布局——注册前没登录也要能读，而且它应该像一页纸，不像一个后台。
 * 但「像一页纸」不等于「自己另画一套」：颜色、字号、圆角、间距全部走 globals.css 的 token，
 * 和产品里其余页面是同一套（设计稿 21/LOW-FREQUENCY：法律页沿用语言，不抢业务设计资源）。
 *
 * 左边那列目录由 LegalBody 在浏览器里从正文的 h2 现扫出来——两份条款各八九节，
 * 手维护一份章节表，改了正文忘了改表就会指到不存在的地方去。
 */
export const 运营主体 = process.env.LEGAL_ENTITY?.trim() || "Daedalus.AI";
export const 联系邮箱 = process.env.LEGAL_CONTACT?.trim() || "qy1g18@gmail.com";

export default function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <div className="legal">
      <header className="legal-top">
        <Link href="/" className="legal-mark" aria-label="Daedalus CRM">
          <Logo size={22} />
          <b>Daedalus CRM</b>
        </Link>
        <nav className="legal-top-n">
          <Link href="/terms">用户协议</Link>
          <Link href="/privacy">隐私政策</Link>
          <Link href="/login" className="legal-back">
            返回登录
          </Link>
        </nav>
      </header>

      <div className="legal-wrap">
        <h1 className="legal-h">{title}</h1>
        <div className="legal-date">更新日期：{updated}</div>
        <LegalBody>{children}</LegalBody>
      </div>
    </div>
  );
}
