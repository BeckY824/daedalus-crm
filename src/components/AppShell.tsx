"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import {
  Layout,
  Menu,
  Input,
  Badge,
  Avatar,
  Dropdown,
  Button,
} from "antd";
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
  SearchOutlined,
  BellOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  DownOutlined,
  LogoutOutlined,
  UserOutlined,
} from "@ant-design/icons";
import type { SessionUser } from "@/lib/auth";
import { SIDER_WIDTH, SIDER_COLLAPSED_WIDTH } from "@/lib/theme";
import { avatarColor, initial, AVATAR_TEXT } from "@/lib/utils";
import Logo from "./Logo";
import { useBusiness } from "@/lib/business-client";

const { Sider, Header, Content } = Layout;

type Props = {
  user: SessionUser;
  pendingCount: number;
  children: React.ReactNode;
};

export default function AppShell({ user, pendingCount, children }: Props) {
  const b = useBusiness();
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  /**
   * 手机上侧栏必须能收到 0 宽，而不是收到 80px。
   * 收到 80 的话，390px 的屏幕上正文只剩 310px 却撑不下，
   * 每个页面都会多出一条横向滚动条——销售从微信里点进来第一眼就是这个。
   */
  const [小屏, set小屏] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const 同步 = () => set小屏(mq.matches);
    同步();
    mq.addEventListener("change", 同步);
    return () => mq.removeEventListener("change", 同步);
  }, []);

  const items = useMemo(
    () => [
      { key: "/dashboard", icon: <HomeOutlined />, label: <Link href="/dashboard">首页</Link> },
      { key: "/overview", icon: <DashboardOutlined />, label: <Link href="/overview">数据看板</Link> },
      { key: "/leads", icon: <ShareAltOutlined />, label: <Link href="/leads">线索管理</Link> },
      { key: "/customers", icon: <TeamOutlined />, label: <Link href="/customers">{b.customer}管理</Link> },
      { key: "/channels", icon: <DeploymentUnitOutlined />, label: <Link href="/channels">渠道管理</Link> },
      { key: "/contacts", icon: <ContactsOutlined />, label: <Link href="/contacts">联系人</Link> },
      {
        key: "opp",
        icon: <DollarOutlined />,
        label: "商机管理",
        children: [
          { key: "/opportunities", label: <Link href="/opportunities">商机列表</Link> },
          { key: "/opportunities/pipeline", label: <Link href="/opportunities/pipeline">商机管道</Link> },
        ],
      },
      {
        key: "follow",
        icon: <InteractionOutlined />,
        label: "跟进管理",
        children: [
          { key: "/follow-ups", label: <Link href="/follow-ups">跟进记录</Link> },
          { key: "/follow-ups/plans", label: <Link href="/follow-ups/plans">跟进计划</Link> },
        ],
      },
      { key: "/reports", icon: <BarChartOutlined />, label: <Link href="/reports">数据复盘</Link> },
      { key: "/settings", icon: <SettingOutlined />, label: <Link href="/settings">设置管理</Link> },
    ],
    [b.customer],
  );

  // 选中项取最长匹配前缀，保证 /customers/xxx 也高亮客户管理
  const selectedKey = useMemo(() => {
    const flat = ["/dashboard", "/overview", "/leads", "/customers", "/channels", "/reports", "/contacts", "/opportunities/pipeline", "/opportunities", "/follow-ups/plans", "/follow-ups", "/settings"];
    return flat.find((k) => pathname === k || pathname.startsWith(k + "/")) ?? "/dashboard";
  }, [pathname]);

  const openKeys = useMemo(() => {
    const o: string[] = [];
    if (selectedKey.startsWith("/opportunities")) o.push("opp");
    if (selectedKey.startsWith("/follow-ups")) o.push("follow");
    return o;
  }, [selectedKey]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider
        width={SIDER_WIDTH}
        collapsed={collapsed}
        collapsedWidth={小屏 ? 0 : SIDER_COLLAPSED_WIDTH}
        // 窄屏自动收起，否则侧栏会挤掉正文空间
        breakpoint="lg"
        onBreakpoint={(broken) => setCollapsed(broken)}
        theme="light"
        style={{ position: "sticky", top: 0, height: "100vh", overflow: "auto", borderRight: "1px solid #eceef2", display: "flex", flexDirection: "column" }}
      >
        {/* 顶行：标 + 名字 + 收/展按钮。收起时只剩标和按钮，按钮永远在顶上同一个位置 */}
        <div className={`sider-logo${collapsed ? " sider-logo-c" : ""}`}>
          <Link href="/dashboard" className="sider-mark" aria-label="Daedalus CRM">
            <Logo size={22} />
          </Link>
          {!collapsed && <span className="sider-name">Daedalus CRM</span>}
          {!小屏 && (
            <Button
              type="text"
              size="small"
              className="sider-fold"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
            />
          )}
        </div>

        {!collapsed && (
          <div className="sider-search">
            <Input
              allowClear
              size="small"
              prefix={<SearchOutlined style={{ color: "#9ca3af" }} />}
              placeholder="搜索客户、联系人、商机"
              variant="filled"
              onPressEnter={(e) => {
                const q = (e.target as HTMLInputElement).value.trim();
                if (q) router.push(`/customers?keyword=${encodeURIComponent(q)}`);
              }}
            />
          </div>
        )}

        <Menu
          theme="light"
          mode="inline"
          items={items}
          selectedKeys={[selectedKey]}
          defaultOpenKeys={openKeys}
          style={{ borderInlineEnd: "none", paddingTop: 4, background: "transparent" }}
        />

        <div style={{ flex: 1 }} />

        {/* 底部：待办计划的计数 + 用户。Attio 把工作区和人都放在侧栏，顶部不再需要一整条栏 */}
        <div className="sider-foot">
          <Link href="/follow-ups/plans" className={`sider-foot-item${collapsed ? " sider-foot-item-c" : ""}`}>
            <BellOutlined />
            {!collapsed && <span>待办计划</span>}
            {pendingCount > 0 && <span className="sider-count">{pendingCount}</span>}
          </Link>
          <Dropdown
            placement="topLeft"
            menu={{
              items: [
                { key: "profile", icon: <UserOutlined />, label: <Link href="/settings">个人设置</Link> },
                { type: "divider" },
                { key: "logout", icon: <LogoutOutlined />, label: "退出登录", danger: true, onClick: logout },
              ],
            }}
          >
            <div className={`sider-foot-item sider-user${collapsed ? " sider-foot-item-c" : ""}`} role="button" tabIndex={0}>
              <Avatar size={24} style={{ background: avatarColor(user.name), color: AVATAR_TEXT, fontSize: 12, fontWeight: 600 }}>
                {initial(user.name)}
              </Avatar>
              {!collapsed && (
                <>
                  <span className="sider-user-name">{user.name}</span>
                  <DownOutlined style={{ fontSize: 10, color: "#9ca3af" }} />
                </>
              )}
            </div>
          </Dropdown>
        </div>
      </Sider>

      <Layout>
        {/* 手机上侧栏收成 0 宽，需要一个入口把它拉出来；桌面上没有顶栏 */}
        {小屏 && (
          <Header
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 12px", borderBottom: "1px solid #eceef2", position: "sticky", top: 0, zIndex: 10, height: 48 }}
          >
            <Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed((c) => !c)} />
            <Logo size={20} />
            <span style={{ fontWeight: 600 }}>Daedalus CRM</span>
            <span style={{ flex: 1 }} />
            <Badge count={pendingCount} size="small" color="#6b7280">
              <Button type="text" icon={<BellOutlined />} onClick={() => router.push("/follow-ups/plans")} />
            </Badge>
          </Header>
        )}

        {/* 超宽屏下限制正文宽度并居中，避免表格被拉得过于稀疏 */}
        <Content className="app-content" style={{ padding: "22px 26px" }}>
          <div style={{ maxWidth: 1720, margin: "0 auto" }}>{children}</div>
        </Content>
      </Layout>
    </Layout>
  );
}
