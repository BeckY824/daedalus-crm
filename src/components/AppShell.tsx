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
  Space,
} from "antd";
import {
  HomeOutlined,
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
  CustomerServiceOutlined,
} from "@ant-design/icons";
import type { SessionUser } from "@/lib/auth";
import { SIDER_WIDTH, SIDER_COLLAPSED_WIDTH } from "@/lib/theme";
import { avatarColor, initial } from "@/lib/utils";
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
      { key: "/dashboard", icon: <HomeOutlined />, label: <Link href="/dashboard">数据首页</Link> },
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
    const flat = ["/dashboard", "/leads", "/customers", "/channels", "/reports", "/contacts", "/opportunities/pipeline", "/opportunities", "/follow-ups/plans", "/follow-ups", "/settings"];
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
        // 窄屏自动收起，否则 248px 的侧栏会挤掉正文空间
        breakpoint="lg"
        onBreakpoint={(broken) => setCollapsed(broken)}
        theme="dark"
        style={{ position: "sticky", top: 0, height: "100vh", overflow: "auto" }}
      >
        <div className="sider-logo">
          <span className="sider-logo-badge">
            <CustomerServiceOutlined />
          </span>
          {!collapsed && <span>CRM 客户管理系统</span>}
        </div>

        <Menu
          theme="dark"
          mode="inline"
          items={items}
          selectedKeys={[selectedKey]}
          defaultOpenKeys={openKeys}
          style={{ borderInlineEnd: "none", paddingTop: 8 }}
        />

      </Sider>

      <Layout>
        <Header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            padding: "0 26px",
            borderBottom: "1px solid #eef2f7",
            position: "sticky",
            top: 0,
            zIndex: 10,
          }}
        >
          <Button
            type="text"
            size="large"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed((c) => !c)}
          />

          <Input
            allowClear
            size="large"
            prefix={<SearchOutlined style={{ color: "#94a3b8" }} />}
            placeholder="搜索客户、联系人、商机等"
            // 手机上藏起来：它是头部最占地方的固定元素，留着就撑破布局
            className="header-search"
            style={{ maxWidth: 400, background: "#f4f7fb" }}
            variant="filled"
            onPressEnter={(e) => {
              const q = (e.target as HTMLInputElement).value.trim();
              if (q) router.push(`/customers?keyword=${encodeURIComponent(q)}`);
            }}
          />

          <div style={{ flex: 1 }} />

          {/* 顶栏只保留铃铛：邮件与帮助两个图标原本点了没有任何反应，
              界面上摆着点不动的东西比没有更糟，已移除。 */}
          <Badge count={pendingCount} size="small" offset={[-2, 4]}>
            <Button type="text" size="large" icon={<BellOutlined style={{ fontSize: 20 }} />} onClick={() => router.push("/follow-ups/plans")} />
          </Badge>

          <Dropdown
            menu={{
              items: [
                { key: "profile", icon: <UserOutlined />, label: <Link href="/settings">个人设置</Link> },
                { type: "divider" },
                { key: "logout", icon: <LogoutOutlined />, label: "退出登录", danger: true, onClick: logout },
              ],
            }}
          >
            <Space style={{ cursor: "pointer", paddingLeft: 10 }} size={11}>
              <Avatar size={40} style={{ background: avatarColor(user.name), fontSize: 17 }}>
                {initial(user.name)}
              </Avatar>
              {/* 窄屏只留头像，否则姓名会被挤成竖排 */}
              {/* 只显示姓名：职位在设置页看得到，摆在这里每屏都占一行、信息量却很低 */}
              <div className="header-user-meta" style={{ fontWeight: 500, fontSize: 15 }}>
                {user.name}
              </div>
              <DownOutlined style={{ fontSize: 12, color: "#94a3b8" }} />
            </Space>
          </Dropdown>
        </Header>

        {/* 超宽屏下限制正文宽度并居中，避免表格被拉得过于稀疏 */}
        <Content className="app-content" style={{ padding: "26px 28px" }}>
          <div style={{ maxWidth: 1720, margin: "0 auto" }}>{children}</div>
        </Content>
      </Layout>
    </Layout>
  );
}
