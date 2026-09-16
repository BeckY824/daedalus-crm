"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { RightOutlined } from "@ant-design/icons";

/**
 * 中栏的过渡形态：一个模块的几个子页。
 * 商机 / 跟进各有两个子页，以前藏在侧栏的折叠菜单里；现在图标栏只有一个入口，
 * 子页就摆在中栏。等这两个模块有了真正的列表视图，这个组件就退场。
 */
export default function SectionPane({ title, items }: { title: string; items: { href: string; label: string; hint: string }[] }) {
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  /**
   * 带 ?tab= 的项（设置页）：地址栏没写 tab 时第一项就是当前页；
   * 其余按最长前缀匹配：/follow-ups/plans 不该同时点亮 /follow-ups。
   */
  const active = (() => {
    const 带页签 = items.filter((i) => i.href.includes("?tab="));
    if (带页签.length && pathname === 带页签[0].href.split("?")[0]) {
      return (tab && 带页签.find((i) => i.href.endsWith(`?tab=${tab}`))?.href) || 带页签[0].href;
    }
    return [...items].sort((a, b) => b.href.length - a.href.length).find((i) => !i.href.includes("?") && (pathname === i.href || pathname.startsWith(i.href + "/")))?.href;
  })();
  return (
    <>
      <div className="pane-h">
        <span className="pane-t">{title}</span>
      </div>
      <div className="pane-rows" style={{ paddingTop: 6 }}>
        {items.map((i) => (
          <Link key={i.href} href={i.href} className={`pane-link${active === i.href ? " on" : ""}`}>
            <span className="pane-link-m">
              <span className="pane-link-t">{i.label}</span>
              <span className="pane-link-s">{i.hint}</span>
            </span>
            <RightOutlined style={{ fontSize: 10, color: "var(--text-muted)" }} />
          </Link>
        ))}
      </div>
    </>
  );
}
