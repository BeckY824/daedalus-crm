import Link from "next/link";
import Logo from "@/components/Logo";

/**
 * 条款页的壳：用户协议、隐私政策共用。
 * 不进 antd，不进应用布局——注册前没登录也要能读，而且它应该像一页纸，不像一个后台。
 */
export const 运营主体 = process.env.LEGAL_ENTITY?.trim() || "Daedalus.AI";
export const 联系邮箱 = process.env.LEGAL_CONTACT?.trim() || "qy1g18@gmail.com";

export default function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "#fff", color: "#1f2937" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "40px 20px 80px", fontSize: 15, lineHeight: 1.85 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 32 }}>
          <Logo size={26} />
          <Link href="/" style={{ color: "#1f2937", fontWeight: 600, textDecoration: "none" }}>
            Daedalus CRM
          </Link>
          <span style={{ flex: 1 }} />
          <Link href="/terms" style={{ fontSize: 13, color: "#6b7280" }}>
            用户协议
          </Link>
          <Link href="/privacy" style={{ fontSize: 13, color: "#6b7280" }}>
            隐私政策
          </Link>
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 600, margin: "0 0 6px", letterSpacing: -0.4 }}>{title}</h1>
        <div style={{ color: "#6b7280", fontSize: 13, marginBottom: 28 }}>最近更新：{updated}</div>
        <div className="legal-body">{children}</div>
        <style>{`
          .legal-body h2 { font-size: 17px; font-weight: 600; margin: 28px 0 8px; }
          .legal-body p { margin: 0 0 10px; }
          .legal-body ul { margin: 0 0 10px; padding-left: 22px; }
          .legal-body li { margin: 2px 0; }
        `}</style>
      </div>
    </div>
  );
}
