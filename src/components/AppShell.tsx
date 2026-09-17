"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
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
  SettingOutlined,
  DeploymentUnitOutlined,
  BellOutlined,
  MenuOutlined,
  LogoutOutlined,
  IdcardOutlined,
  DownOutlined,
} from "@ant-design/icons";
import type { SessionUser } from "@/lib/auth";
import { avatarColor, initial, AVATAR_TEXT } from "@/lib/utils";
import Logo from "./Logo";
import UpdateButton from "./UpdateButton";
import AiTasks from "./AiTasks";
import CommandBar from "./CommandBar";
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
 * 壳：
 *   左栏 164px —— 全局导航，八个模块 + 底部 AI 任务 / 设置 / 账号。**永远在，永远这八个**
 *   中栏 312px —— **不是默认栏位**。只有「要在同类记录之间连着切」的场景才出现，
 *                 眼下只有学员记录页的窄名单一个。首页、数据、六张列表、设置都没有中栏
 *   右栏       —— 各页正文
 *
 * 「全局导航稳定，局部结构服从任务」是全站唯一那条布局规则（设计稿 03/LAYOUT）：
 *   首页 / 数据 = 导航 + 单一工作画布
 *   列表页      = 导航 + 全宽表格
 *   记录页      = 导航 + 窄名单 + 记录
 *   设置        = 导航 + 设置目录 + 内容（目录在页内，不占中栏）
 *
 * 导航文案就是模块名，不带「管理」二字：那两个字每一项都有，等于每一项都没有。
 * 每个入口都带 aria-label，屏幕阅读器和 e2e 都按这个名字找。
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
      { key: "/overview", icon: <DashboardOutlined />, label: "数据" },
      { key: "/leads", icon: <ShareAltOutlined />, label: "线索" },
      { key: "/customers", icon: <TeamOutlined />, label: b.customer },
      { key: "/channels", icon: <DeploymentUnitOutlined />, label: "渠道" },
      { key: "/contacts", icon: <ContactsOutlined />, label: "联系人" },
      { key: "/opportunities", icon: <DollarOutlined />, label: "商机" },
      { key: "/follow-ups", icon: <InteractionOutlined />, label: "跟进" },
    ],
    [b.customer],
  );

  // 选中项取最长匹配前缀，/customers/xxx 也算在客户管理下
  const 少动 = useReducedMotion();
  const selectedKey = useMemo(() => {
    const flat = ["/dashboard", "/overview", "/leads", "/customers", "/channels", "/reports", "/contacts", "/opportunities", "/follow-ups", "/settings"];
    return flat.find((k) => pathname === k || pathname.startsWith(k + "/")) ?? "/dashboard";
  }, [pathname]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  /**
   * 退出登录。桌面端本地模式下它退的是**云端账号**（api/auth/logout 会顺手吊销这台机器的
   * 设备令牌），退完落到的登录页画的就是云端账号那张表单，注册、找回密码都在。
   * 2026-09-17 上午曾把这一条在本机模式下藏起来——因为那时退出之后落到的是一个要
   * 本机随机密码的框。根子是两套身份，不是这个按钮；两套并成一套之后它就该回来。
   */
  /**
   * 账号菜单。**这里只放三样**：我是谁、改我自己的、出去。
   * 参照 Claude / Codex 桌面端那两个菜单，但没把它们那一长串照抄——
   * 语言只有中文、升级套餐我们不卖、更新有自己的按钮，抄过来每一条都是死链。
   * 顶上那块是身份（名字、职位、登录名），不可点：菜单第一件事是告诉你「现在是谁」，
   * 尤其是一台机器上换过账号的时候。
   */
  const userMenu = {
    items: [
      {
        type: "group" as const,
        label: (
          <div className="rail-menu-me">
            <Avatar size={32} style={{ background: avatarColor(user.name), color: AVATAR_TEXT, fontSize: 13, fontWeight: 600, flex: "none" }}>
              {initial(user.name)}
            </Avatar>
            <div style={{ minWidth: 0 }}>
              <b>{user.name}</b>
              <span>{[user.title, user.email].filter(Boolean).join(" · ")}</span>
            </div>
          </div>
        ),
      },
      { type: "divider" as const },
      { key: "profile", icon: <IdcardOutlined />, label: <Link href="/settings?tab=profile">个人资料</Link> },
      {
        key: "settings",
        icon: <SettingOutlined />,
        label: (
          <span className="rail-menu-row">
            <Link href="/settings">设置</Link>
            {desktop && <kbd>⌘,</kbd>}
          </span>
        ),
      },
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
              {/* 选中那块底色是**同一块**在两项之间滑过去的（layoutId），不是这边灭那边亮。
                  切页时眼睛跟着它走，不用重新找自己在哪一项上。
                  系统开了「减弱动态效果」就按 0 秒，等于原来的瞬切。 */}
              {selectedKey === n.key && (
                <motion.span layoutId="rail-on" className="rail-on-bg" transition={{ duration: 少动 ? 0 : 0.18, ease: [0.2, 0.8, 0.2, 1] }} />
              )}
              {n.icon}
              <b>{n.label}</b>
            </Link>
          ))}
        </div>
        {/* 侧栏底部按设计稿只留三样：AI 任务、设置、账号。
            原来还挂着一条「⌘K 跳转 / 提问」的说明和一个「待办」铃铛——
            快捷键的说明挪到了首页输入框下面（那儿才是用它的地方），
            逾期待办改由首页第一个信号「逾期跟进 N · 先处理」承担：
            那是一个带数字和去处的信号，比一个只有小红点的铃铛准。 */}
        <div className="rail-foot">
          {/* 正在跑 / 已答完的 AI 任务。切到别的页面也看得见，点一条回原处 */}
          <AiTasks />
          {/* 「设置」不在左栏里了（2026-09-17）：它在账号菜单里，和 Claude / Codex 一样。
              左栏那一列是**你工作的地方**——学员、商机、跟进；设置是偶尔去一趟的抽屉，
              把它摆成和「学员」同级的一项，等于每天提醒你它存在。 */}
          {/* 账号这一行右端留给更新键：有新版才出现，没有就当它不存在，一行都不占。
              它不能嵌在账号按钮里面（按钮套按钮点不动），所以这一行是个 flex 容器，
              左边账号自己撑开、右边那枚圆键跟着。形状照 Codex：名字在左，圆键在右。 */}
          <div className="rail-account">
            {/* 点开，不是悬停。悬停开的菜单会在你只是路过时糊你一脸，
                而且右边那个小箭头说的就是「点我」——两者得是一回事 */}
            <Dropdown placement="topLeft" trigger={["click"]} menu={userMenu}>
              <button type="button" className="rail-user" aria-label={`${user.name}，账号菜单`}>
                <Avatar size={24} style={{ background: avatarColor(user.name), color: AVATAR_TEXT, fontSize: 11, fontWeight: 600, flex: "none" }}>
                  {initial(user.name)}
                </Avatar>
                {/* 名字长了就省略号收尾，不再把整行吃掉；右边那个小箭头是「这儿能点开」的唯一信号——
                    在它之前，这一行和一条静态的署名长得一模一样 */}
                <b>{user.name}</b>
                <DownOutlined className="rail-user-caret" aria-hidden />
              </button>
            </Dropdown>
            {desktop && <UpdateButton />}
          </div>
        </div>
      </nav>

      {/* ⌘K：跳页或问一句。挂在壳上，哪一页都在 */}
      <CommandBar />

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
