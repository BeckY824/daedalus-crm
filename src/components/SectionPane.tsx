"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { RightOutlined } from "@ant-design/icons";

/**
 * 中栏的过渡形态：一个模块的几个子页。
 * 商机 / 跟进各有两个子页，以前藏在侧栏的折叠菜单里；现在图标栏只有一个入口，
 * 子页就摆在中栏。等这两个模块有了真正的列表视图，这个组件就退场。
 */
export default function SectionPane({ title, items }: { title: string; items: { href: string; label: string; hint: string }[] }) {
  const pathname = usePathname();
  // 最长匹配：/follow-ups/plans 不该同时点亮 /follow-ups
  const active = [...items].sort((a, b) => b.href.length - a.href.length).find((i) => pathname === i.href || pathname.startsWith(i.href + "/"))?.href;
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
            <RightOutlined style={{ fontSize: 10, color: "#9ca3af" }} />
          </Link>
        ))}
      </div>
    </>
  );
}
