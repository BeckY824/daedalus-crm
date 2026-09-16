"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { Layout, Avatar, Dropdown, Button, Badge } from "antd";
import {
  HomeOutlined,
  DashboardOutlined,
  ShareAltOutlined,
  TeamOutlined,
  ContactsOutlined,
  DollarOutlined,
  InteractionOutlined,
  BarChartOutlined,
  SettingOutlined,
  DeploymentUnitOutlined,
  BellOutlined,
  MenuOutlined,
  LogoutOutlined,
  UserOutlined,
} from "@ant-design/icons";
import type { SessionUser } from "@/lib/auth";
import { avatarColor, initial, AVATAR_TEXT } from "@/lib/utils";
import Logo from "./Logo";
import UpdateButton from "./UpdateButton";
import { useBusiness } from "@/lib/business-client";

const { Header, Content } = Layout;

type Props = {
  user: SessionUser;
  pendingCount: number;
  /** 跑在桌面端（Electron）里：红黄绿钮嵌在图标栏顶上，系统标题栏不再画 */
  desktop: boolean;
  /**
   * 中栏，由并行路由槽位 @pane/[[...slug]] 渲染好传进来，连 <aside class="pane"> 一起。
   * 没有中栏的路由那边返回 null，这里什么都不画——壳不该知道哪个模块有中栏。
   */
  pane: React.ReactNode;
  children: React.ReactNode;
};

/**
 * 壳（2026-09-15 起三栏）：
 *   图标栏 76px —— 只放图标，产品名只剩一个标；桌面端的红黄绿钮嵌在最上面
 *   中栏 352px —— 当前模块的列表：首页是「今天」，学员是最近跟进的 50 位，商机 / 跟进是它们的两个子页；
 *                 其它模块还没有列表视图，中栏不出现，正文直接接在图标栏右边
 *   右栏      —— 各页正文
 * 参考 Claude Code / Codex 桌面版的窗口形态。网页版和桌面端共用这一份。
 *
 * 图标栏每个入口都带 aria-label 全名（首页 / 学员管理 …），屏幕阅读器和 e2e 都按这个名字找。
 */
export default function AppShell({ user, pendingCount, desktop, pane, children }: Props) {
  const b = useBusiness();
  const router = useRouter();
  const pathname = usePathname();
  /**
   * 手机上没有图标栏和中栏：390px 宽的屏幕摆不下三栏。
   * 顶部一条栏 + 一个菜单按钮，正文占满。
   */
  const [小屏, set小屏] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const 同步 = () => set小屏(mq.matches);
    同步();
    mq.addEventListener("change", 同步);
    return () => mq.removeEventListener("change", 同步);
  }, []);

  const nav = useMemo(
    () => [
      { key: "/dashboard", icon: <HomeOutlined />, label: "首页" },
      { key: "/overview", icon: <DashboardOutlined />, label: "数据看板" },
      { key: "/leads", icon: <ShareAltOutlined />, label: "线索管理" },
      { key: "/customers", icon: <TeamOutlined />, label: `${b.customer}管理` },
      { key: "/channels", icon: <DeploymentUnitOutlined />, label: "渠道管理" },
      { key: "/contacts", icon: <ContactsOutlined />, label: "联系人" },
      { key: "/opportunities", icon: <DollarOutlined />, label: "商机管理" },
      { key: "/follow-ups", icon: <InteractionOutlined />, label: "跟进管理" },
      { key: "/reports", icon: <BarChartOutlined />, label: "数据复盘" },
    ],
    [b.customer],
  );

  // 选中项取最长匹配前缀，/customers/xxx 也算在客户管理下
  const selectedKey = useMemo(() => {
    const flat = ["/dashboard", "/overview", "/leads", "/customers", "/channels", "/reports", "/contacts", "/opportunities", "/follow-ups", "/settings"];
    return flat.find((k) => pathname === k || pathname.startsWith(k + "/")) ?? "/dashboard";
  }, [pathname]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const userMenu = {
    items: [
      { key: "profile", icon: <UserOutlined />, label: <Link href="/settings">个人设置</Link> },
      { type: "divider" as const },
      { key: "logout", icon: <LogoutOutlined />, label: "退出登录", danger: true, onClick: logout },
    ],
  };

  if (小屏) {
    return (
      <Layout style={{ minHeight: "100vh" }}>
        <Header style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 12px", borderBottom: "1px solid #eceef2", position: "sticky", top: 0, zIndex: 10, height: 48 }}>
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [...nav, { key: "/settings", icon: <SettingOutlined />, label: "设置管理" }].map((n) => ({ key: n.key, icon: n.icon, label: <Link href={n.key}>{n.label}</Link> })),
              selectedKeys: [selectedKey],
            }}
          >
            <Button type="text" icon={<MenuOutlined />} aria-label="打开导航菜单" />
          </Dropdown>
          <Link href="/dashboard" aria-label="Daedalus CRM" style={{ display: "inline-flex" }}>
            <Logo size={20} />
          </Link>
          <span style={{ flex: 1 }} />
          <Badge count={pendingCount} size="small" color="#6b7280">
            <Button type="text" icon={<BellOutlined />} aria-label="待办计划" onClick={() => router.push("/follow-ups/plans")} />
          </Badge>
        </Header>
        <Content className="app-content" style={{ padding: "22px 26px" }}>
          {children}
        </Content>
      </Layout>
    );
  }

  return (
    <div className={`shell${desktop ? " shell-desktop" : ""}`}>
      {/* 桌面端顶上那条能拖窗口的把手，见 globals.css 的 .drag-strip */}
      {desktop && <div className="drag-strip" aria-hidden="true" />}
      <nav className="rail" aria-label="主导航">
        {/* 桌面端：这块是红黄绿钮的位置，也是拖动窗口的把手 */}
        <div className="rail-top">
          <Link href="/dashboard" className="rail-mark" aria-label="Daedalus CRM">
            <Logo size={20} />
            <b>Daedalus CRM</b>
          </Link>
        </div>
        {/* 名字直接写出来，不再靠 tooltip：第一次打开的人不会去悬停，
            他只看到一列认不出的方块。aria-label 保留原样，e2e 和读屏都认它。 */}
        <div className="rail-nav">
          {nav.map((n) => (
            <Link key={n.key} href={n.key} aria-label={n.label} className={`rail-item${selectedKey === n.key ? " on" : ""}`}>
              {n.icon}
              <b>{n.label}</b>
            </Link>
          ))}
        </div>
        <div className="rail-foot">
          {desktop && <UpdateButton />}
          <Link href="/settings" aria-label="设置管理" className={`rail-item${selectedKey === "/settings" ? " on" : ""}`}>
            <SettingOutlined />
            <b>设置</b>
          </Link>
          <Link href="/follow-ups/plans" aria-label="待办计划" className="rail-item rail-bell">
            <BellOutlined />
            {pendingCount > 0 && <span className="rail-count">{pendingCount}</span>}
            <b>待办</b>
          </Link>
          <Dropdown placement="topLeft" menu={userMenu}>
            <button type="button" className="rail-user" aria-label={`${user.name}，账号菜单`}>
              <Avatar size={24} style={{ background: avatarColor(user.name), color: AVATAR_TEXT, fontSize: 11, fontWeight: 600, flex: "none" }}>
                {initial(user.name)}
              </Avatar>
              <b>{user.name}</b>
            </button>
          </Dropdown>
        </div>
      </nav>

      {/* 中栏：槽位自己带 <aside class="pane">，没有中栏的路由返回 null */}
      {pane}

      {/* antd 的 Content 自己就渲染成 <main>，外面不能再包一层：
          一个文档只能有一个 main，两个会让读屏和测试都认不出正文是哪块 */}
      <main className="main app-content" style={{ padding: "22px 26px" }}>
        {/* 超宽屏下限制正文宽度并居中，避免表格被拉得过于稀疏 */}
        <div style={{ maxWidth: 1720, margin: "0 auto" }}>{children}</div>
      </main>
    </div>
  );
}
