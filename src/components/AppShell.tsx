"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { palette } from "@/lib/palette";
import { useRouter, usePathname } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { 要跟Context } from "./FollowDue";
import Link from "next/link";
import { Layout, Avatar, Dropdown, Button, Badge } from "antd";
import {
  SearchOutlined,
  HomeOutlined,
  DashboardOutlined,
  MessageOutlined,
  ShareAltOutlined,
  TeamOutlined,
  ContactsOutlined,
  DollarOutlined,
  ContainerOutlined,
  ShopOutlined,
  InteractionOutlined,
  SettingOutlined,
  HistoryOutlined,
  DeploymentUnitOutlined,
  BellOutlined,
  MenuOutlined,
  LogoutOutlined,
  DownOutlined,
} from "@ant-design/icons";
import type { SessionUser } from "@/lib/auth";
import { avatarColor, initial, AVATAR_TEXT } from "@/lib/utils";
import Logo from "./Logo";
import UpdateRow from "./UpdateRow";
import WhatsNew from "./WhatsNew";
import AiTasks from "./AiTasks";
import AiDock from "./AiDock";
import { usePageUnderOverlay } from "@/lib/page-under-overlay";
import type { ModelOption } from "@/lib/llm";
import FeedbackButton from "./FeedbackButton";
import { AiMeterBar } from "./AiCost";
import RailResizer from "./RailResizer";
import CommandBar from "./CommandBar";
import Shortcut from "./Shortcut";
import { useBusiness } from "@/lib/business-client";
import { DockOpenContext, useNarrow, usePageOwnsCmdK } from "@/lib/roster";
import { useMotionTheme } from "@/components/MotionTheme";

const { Header, Content } = Layout;

declare global {
  interface Window {
    /** 壳→页面的一条单向指令：菜单里点了「设置」，由页面自己 push 过去（见 desktop/preload-app.js） */
    desktopNav?: { onGo(cb: (路径: string) => void): () => void };
  }
}

type Props = {
  user: SessionUser;
  /** 左栏「收藏的客户」（lib/favorites.ts）。没收藏过就整栏不出现 */
  收藏?: { id: string; name: string }[];
  /** 导航项右边的数（2026-10-02 照毛玻璃原型）：客户总数、在谈的商机。只给有意义的那几项 */
  计数?: Partial<Record<string, number>>;
  /**
   * 要跟的：我名下逾期 + 今天到期、还没做的计划和待办（lib/reminders-db.ts）。
   * 和桌面端 Dock 上的数是同一个——左栏「跟进」、手机顶栏铃铛都挂它，人在 Dock 上看见 1，打开应用能顺着找到那个 1
   */
  要跟: { 逾期: number; 今天: number };
  /**
   * 订单里要看的节点（外贸模版，2026-10-03）：超期 + 今天到期。挂在左栏「订单」上，
   * Dock 上的数 = 「跟进」这个数 + 它（lib/reminders.ts）。没有订单就是 0，什么都不显示
   */
  订单要看?: { 超期: number; 今天: number };
  /** 跑在桌面端（Electron）里：红黄绿钮嵌在图标栏顶上，系统标题栏不再画 */
  desktop: boolean;
  /**
   * 反馈发到哪儿。托管版和桌面端发到我们云端；自部署的开源版不发请求，
   * 点了直接开 GitHub issues——他的实例不该认识我们的云。
   */
  反馈去向: "cloud" | "github";
  /**
   * 中栏，由并行路由槽位 @pane/[[...slug]] 渲染好传进来，连 <aside class="pane"> 一起。
   * 没有中栏的路由那边返回 null，这里什么都不画——壳不该知道哪个模块有中栏。
   */
  pane: React.ReactNode;
  /**
   * 全局 AI 面板要的东西。没配 AI 时是 null——那时整个面板和那枚按钮都不该存在，
   * 而不是点开一个说"先去设置里配 AI"的空壳。
   */
  ai: { models: ModelOption[] } | null;
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
/** 面板常驻要的最小窗口宽度，见 AppShell 里 窄窗 那段 */
const 面板放不下 = "(max-width: 1599px)";

export default function AppShell({ user, 收藏 = [], 计数 = {}, 要跟, 订单要看 = { 超期: 0, 今天: 0 }, desktop, 反馈去向, pane, ai, children }: Props) {
  const { 曲线, 时长 } = useMotionTheme();
  const b = useBusiness();
  const router = useRouter();
  const pathname = usePathname();
  const 页内占着CmdK = usePageOwnsCmdK();
  /** 设置浮层开着时，底下那页（不是地址栏的 /settings）。见 lib/page-under-overlay.ts */
  const 底下那页 = usePageUnderOverlay();
  /**
   * 手机上没有图标栏和中栏：390px 宽的屏幕摆不下三栏。
   * 顶部一条栏 + 一个菜单按钮，正文占满。
   */
  const 小屏 = useNarrow("(max-width: 767px)");
  /**
   * AI 面板开着没有。壳要知道，因为 antd 的响应式断点看的是**视口**，
   * 而面板一开正文就只剩 1440 - 220 - 380 ≈ 840——断点还以为自己有 1440，
   * 于是 xl 的两栏照摆，表格被挤到「推荐人」三个字竖着排。见 globals.css 的 .shell-dock-open。
   *
   * **默认开着**（用户定的：「保持常驻吧，不要点击或者 command J 才能开启」）。
   * 关掉之后记住——那是他这台机器上的选择，不必每次开窗口重来。
   */
  const 存的面板 = useSyncExternalStore(
    () => () => {},
    () => {
      try {
        return localStorage.getItem("dock-open") !== "0";
      } catch {
        return true; // 隐私模式下读不到就用默认（开着）
      }
    },
    // 服务端快照：先按默认（开着）渲染，水合之后再换成这台机器上存的那个。
    // 不能在 effect 里 setState——那是「effect 里同步 setState」，会级联渲染
    () => true,
  );
  /**
   * **放得下才常驻**：窗口不到 1600 宽时面板默认收着，⌘J 照样打得开，手动开合过就听手动的。
   *
   * 2026-09-28 拿 11 段教程的录制脚本对着当前代码重跑查出来的。教程录的时候没登录 AI，画面里没有面板；
   * 登录了的真实用户面板默认常驻，正文只剩「窗口 - 左栏 220 - 面板 380」：
   *   - 1120 宽剩 520：客户表只剩「客户」「公司」两列，档案页塌成一栏
   *   - 1440（应用的默认窗口）剩 840：商机看板只露两列半，拖卡片拖不到右边那几列
   * 常驻是用户定的，所以不是去掉，而是放得下才常驻：1600 起正文还有 1000，看板和表格都摆得开
   * （16 寸 MacBook、外接屏）；13、14 寸笔记本的 1440–1512 默认收着，和教程里的样子一致。
   */
  // 服务端不知道窗口多宽，按多数（笔记本）当窄的、先收着：宽屏水合后展开一次，
  // 好过笔记本上每次先渲染出 380 的面板、再在水合后收回去
  const 窄窗 = useNarrow(面板放不下, true);
  /** 这一次会话里手动开合过。null = 还没动过，听存档的 */
  const [手动, set手动] = useState<boolean | null>(null);
  /** 账号菜单「更新记录」开着没有（桌面端才有这一条） */
  const [更新记录开着, set更新记录开着] = useState(false);
  const 面板开着 = 手动 ?? (窄窗 ? false : 存的面板);
  /** 名单和记录页的断点要知道右边这条面板占了地方（见 lib/roster.ts 的 DockOpenContext） */
  const 面板占着地方 = Boolean(ai) && !小屏 && 面板开着 && 底下那页 !== "/dashboard";
  const 记住面板 = (开: boolean) => {
    set手动(开);
    try {
      localStorage.setItem("dock-open", 开 ? "1" : "0");
    } catch {
      // 存不下就只在这一次会话里生效
    }
  };
  /**
   * 壳里按 ⌘, 或点菜单里的「设置」：**由这边 push**，不是壳去 loadURL。
   * 软导航才命中拦截路由（@modal/(.)settings），设置才是盖在当前页上的那一层——
   * 否则同一个「设置」从菜单进是整页、从账号菜单进是浮层，同一个标签两种样子。
   * 网页版没有这座桥，这个 effect 什么都不做。
   */
  useEffect(() => window.desktopNav?.onGo((路径) => router.push(路径)), [router]);

  const 要跟数 = 要跟.逾期 + 要跟.今天;
  const 要跟说法 = 要跟数 > 0 ? `要跟 ${要跟数} 条${要跟.逾期 > 0 ? `（逾期 ${要跟.逾期}）` : ""}` : "";
  /*
    这个数一变（在哪儿完成了计划、勾了待办、改了时间——各处都会 router.refresh()，layout 重算），
    就叫桌面端的壳马上再问一次，Dock 上的数跟着变。原来只有计划页会叫，别处处理完 Dock 要等下一分钟。
    首次挂载不叫：壳自己启动后就在问
  */
  const 订单数 = 订单要看.超期 + 订单要看.今天;
  const 订单说法 = 订单数 > 0 ? `${订单数} 个节点要看${订单要看.超期 > 0 ? `（超期 ${订单要看.超期}）` : ""}` : "";
  const 上次要跟 = useRef<number | null>(null);
  useEffect(() => {
    if (上次要跟.current !== null && 上次要跟.current !== 要跟数 + 订单数) void window.desktopReminders?.刷新();
    上次要跟.current = 要跟数 + 订单数;
  }, [要跟数, 订单数]);

  const nav = useMemo(
    () => [
      /*
        2026-10-02 照毛玻璃原型分成两组：上面是每天都点的（首页、客户、商机、跟进、数据，原型的顺序），
        下面「更多」是偶尔去一趟的（线索、联系人、渠道）。一个入口都没少，只是不再八项平铺、一样重。
        沟通、找客做好以后插在商机后面。
      */
      { key: "/dashboard", icon: <HomeOutlined />, label: "首页", 组: "主" },
      { key: "/customers", icon: <TeamOutlined />, label: b.customer, 组: "主" },
      { key: "/opportunities", icon: <DollarOutlined />, label: "商机", 组: "主" },
      // 外贸模版才有订单（2026-10-03）：通用销售没有「定金 → 生产 → 订舱 → 装柜」这条线，摆着只是添乱
      ...(b.template === "trade" ? [{ key: "/orders", icon: <ContainerOutlined />, label: "订单", 组: "主" as const }] : []),
      { key: "/follow-ups", icon: <InteractionOutlined />, label: "跟进", 组: "主" },
      { key: "/overview", icon: <DashboardOutlined />, label: "数据", 组: "主" },
      { key: "/leads", icon: <ShareAltOutlined />, label: "线索", 组: "更多" },
      { key: "/contacts", icon: <ContactsOutlined />, label: "联系人", 组: "更多" },
      { key: "/channels", icon: <DeploymentUnitOutlined />, label: "渠道", 组: "更多" },
      // 供应商（3c）同样外贸才有：通用销售没有「找工厂比价」这一步
      ...(b.template === "trade" ? [{ key: "/suppliers", icon: <ShopOutlined />, label: "供应商", 组: "更多" as const }] : []),
    ],
    [b.customer, b.template],
  );

  // 选中项取最长匹配前缀，/customers/xxx 也算在客户管理下
  const 少动 = useReducedMotion();
  const selectedKey = useMemo(() => {
    const flat = ["/dashboard", "/overview", "/leads", "/customers", "/channels", "/reports", "/contacts", "/opportunities", "/orders", "/suppliers", "/follow-ups", "/settings"];
    return flat.find((k) => pathname === k || pathname.startsWith(k + "/")) ?? "/dashboard";
  }, [pathname]);

  /** 左栏的一项（主导航和「更多」共用）。选中那块底色仍是同一块在各项之间滑（layoutId） */
  const 一项 = (n: (typeof nav)[number]) => (
    <Link
      key={n.key}
      /* 桌面端的「客户」直接进「名单 + 详情」，打开最近看过的那位（照毛玻璃原型）；表格在名单右上角。
         网页团队版照旧进表格：那边要按人分配、批量改，表格是主场。手机菜单也照旧进表格 */
      href={desktop && n.key === "/customers" ? "/customers/recent" : n.key}
      prefetch={desktop && n.key === "/customers" ? false : undefined}
      /* 跳转页的结果会被客户端路由缓存住（staleTimes 60 秒）：第二次点会回到上一次跳去的那位，
         不是刚看过的那位。每次带一个新参数，确保回到服务端读 cookie */
      onClick={
        desktop && n.key === "/customers"
          ? (e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey) return;
              e.preventDefault();
              router.push(`/customers/recent?t=${Date.now()}`);
            }
          : undefined
      }
      aria-label={n.key === "/follow-ups" && 要跟说法 ? `${n.label}，${要跟说法}` : n.key === "/orders" && 订单说法 ? `${n.label}，${订单说法}` : n.label}
      className={`rail-item${selectedKey === n.key ? " on" : ""}`}
    >
      {/* 选中那块底色是**同一块**在两项之间滑过去的（layoutId），不是这边灭那边亮。
          切页时眼睛跟着它走，不用重新找自己在哪一项上。
          系统开了「减弱动态效果」就按 0 秒，等于原来的瞬切。 */}
      {selectedKey === n.key && (
        <motion.span layoutId="rail-on" className="rail-on-bg" transition={{ duration: 少动 ? 0 : 时长.base, ease: 曲线.ease }} />
      )}
      {n.icon}
      <b>{n.label}</b>
      {/* 和 Dock 上那个红数字同一个数、同一种红：人从 Dock 看见 1，打开应用第一眼就能对上它在哪。
          点进去是记录页，页头「计划」按钮上还挂着同一个数，再点就是逾期和今天那两组 */}
      {n.key === "/follow-ups" && 要跟数 > 0 && (
        <span className="rail-count" title={`${要跟说法}，和 Dock 上的数一样`}>{要跟数 > 99 ? "99+" : 要跟数}</span>
      )}
      {n.key === "/orders" && 订单数 > 0 && (
        <span className="rail-count" title={`${订单说法}，算在 Dock 上的数里`}>{订单数 > 99 ? "99+" : 订单数}</span>
      )}
      {/* 灰的数只是「有多少」，不是「要处理」：和上面那个红的分开，红的才催人 */}
      {(计数[n.key] ?? 0) > 0 && <span className="rail-num">{计数[n.key]}</span>}
    </Link>
  );

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
   * 账号菜单。**这里只放两样**：我是谁、出去——中间那条是通往设置的门。
   * 参照 Claude / Codex 桌面端那两个菜单，但没把它们那一长串照抄——
   * 语言只有中文、升级套餐我们不卖、更新有自己的按钮，抄过来每一条都是死链。
   * 顶上那块是身份（名字、职位、登录名），不可点：菜单第一件事是告诉你「现在是谁」，
   * 尤其是一台机器上换过账号的时候。
   *
   * **「个人资料」不在这儿了（2026-09-18）**：它是设置里的第一栏，菜单里再摆一条
   * 等于同一个地方开两个门，而且两条只差一个字——点哪条得先想一下。要改名字、改职位，
   * 打开设置，第一栏就是。
   *
   * **每一条走 onClick，不在 label 里塞 `<Link>`。** 塞进去只有那两个字是可点的：
   * 点在图标上、点在右边那片空白上，菜单关掉、什么也没发生——0.34.1 收到的
   * 「点设置完全没反应」就是这个。antd 的 onClick 认的是整行，行有多宽就能点多宽。
   */
  const userMenu = {
    onClick: ({ key }: { key: string }) => {
      // 软导航才会命中拦截路由（@modal/(.)settings），设置才是盖在当前页上的一层
      if (key === "settings") router.push("/settings");
      if (key === "whats-new") set更新记录开着(true);
      if (key === "logout") void logout();
    },
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
      {
        key: "settings",
        icon: <SettingOutlined />,
        label: (
          <span className="rail-menu-row">
            设置
            {desktop && <kbd><Shortcut>⌘,</Shortcut></kbd>}
          </span>
        ),
      },
      // 更新记录只有桌面端有：网页版一直是最新的，没有「从哪一版升上来」这回事
      ...(desktop ? [{ key: "whats-new", icon: <HistoryOutlined />, label: "更新记录" }] : []),
      { type: "divider" as const },
      { key: "logout", icon: <LogoutOutlined />, label: "退出登录", danger: true },
    ],
  };

  if (小屏) {
    // 底色走 --page-bg：外观选白底时地面跟着变白（antd 的 bodyBg 是 JS 里写死的色值，读不到外观）
    return (
      <Layout style={{ minHeight: "100vh", background: "var(--page-bg)" }}>
        <Header style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 12px", borderBottom: "1px solid var(--line-soft)", position: "sticky", top: 0, zIndex: 10, height: 48 }}>
          <Dropdown
            trigger={["click"]}
            menu={{
              /* 整行可点：label 里塞 <Link> 的话，点在图标或右边空白上只会把菜单关掉 */
              items: [...nav, { key: "/settings", icon: <SettingOutlined />, label: "设置管理" }],
              selectedKeys: [selectedKey],
              onClick: ({ key }) => router.push(key),
            }}
          >
            <Button type="text" icon={<MenuOutlined />} aria-label="打开导航菜单" />
          </Dropdown>
          <Link href="/dashboard" aria-label="Daedalus CRM" style={{ display: "inline-flex" }}>
            <Logo size={20} />
          </Link>
          <span style={{ flex: 1 }} />
          {/* 手机上也要能说一句：用得别扭的时刻多半就发生在手机上（在路上翻学员的时候） */}
          <FeedbackButton 去向={反馈去向} />
          <Badge count={要跟数} size="small" color={要跟.逾期 > 0 ? "var(--danger)" : palette.textMuted}>
            <Button type="text" icon={<BellOutlined />} aria-label={要跟说法 ? `跟进计划，${要跟说法}` : "跟进计划"} onClick={() => router.push("/follow-ups/plans")} />
          </Badge>
        </Header>
        <Content className="app-content" style={{ padding: "22px 26px" }}>
          <要跟Context.Provider value={要跟}>{children}</要跟Context.Provider>
        </Content>
      </Layout>
    );
  }

  return (
    <DockOpenContext.Provider value={面板占着地方}>
    <div className={`shell${desktop ? " shell-desktop" : ""}${面板开着 && 底下那页 !== "/dashboard" ? " shell-dock-open" : ""}`}>
      {/* 桌面端顶上那条能拖窗口的把手，见 globals.css 的 .drag-strip */}
      {desktop && <div className="drag-strip" aria-hidden="true" />}
      <nav className="rail" aria-label="主导航">
        {/* 桌面端：这块是红黄绿钮的位置，也是拖动窗口的把手 */}
        <div className="rail-top">
          {/*
            桌面端顶上是一个搜索框（2026-10-02 照毛玻璃原型，学 MonoCode）：名字已经在登录页和红黄绿钮旁的窗口里了，
            这一格留给最常用的「去哪儿 / 找谁」。点它和按 ⌘K 是同一张跳转单（CommandBar 听 cmdbar:open）。
            网页版没有红黄绿钮那一截，顶上还是标志，不然整个页面上就找不到自己在哪个产品里。
          */}
          {desktop ? (
            <button type="button" className="rail-search" onClick={() => window.dispatchEvent(new Event("cmdbar:open"))} aria-label={页内占着CmdK ? "搜索" : "搜索（⌘K）"}>
              <SearchOutlined />
              <span>搜索</span>
              {/* 首页的 ⌘K 是「回问答框」、记录页是「换一位」：那两处不写，免得标签和按下去的对不上（lib/roster.ts） */}
              {!页内占着CmdK && <kbd><Shortcut>⌘K</Shortcut></kbd>}
            </button>
          ) : (
            <Link href="/dashboard" className="rail-mark" aria-label="Daedalus CRM">
              <Logo size={20} />
              <b>Daedalus CRM</b>
            </Link>
          )}
        </div>
        {/* 名字直接写出来，不再靠 tooltip：第一次打开的人不会去悬停，
            他只看到一列认不出的方块。aria-label 保留原样，e2e 和读屏都认它。 */}
        <div className="rail-nav">
          {nav.filter((n) => n.组 === "主").map((n) => 一项(n))}
        </div>
        <div className="rail-more" aria-label="更多">
          <div className="rail-fav-h">更多</div>
          {nav.filter((n) => n.组 === "更多").map((n) => 一项(n))}
        </div>
        {收藏.length > 0 && (
          <div className="rail-fav" aria-label="收藏的客户">
            <div className="rail-fav-h">收藏的{b.customer}</div>
            {收藏.map((c) => (
              <Link key={c.id} href={`/customers/${c.id}`} className={`rail-fav-i${pathname === `/customers/${c.id}` ? " on" : ""}`}>
                <span className="rail-fav-av" style={{ background: avatarColor(c.name), color: AVATAR_TEXT }}>
                  {initial(c.name)}
                </span>
                <span className="rail-fav-n">{c.name}</span>
              </Link>
            ))}
          </div>
        )}
        {/* 侧栏底部按设计稿只留三样：AI 任务、设置、账号。
            原来还挂着一条「⌘K 跳转 / 提问」的说明和一个「待办」铃铛——
            快捷键的说明挪到了首页输入框下面（那儿才是用它的地方），
            逾期待办改由首页第一个信号「逾期跟进 N · 先处理」承担：
            那是一个带数字和去处的信号，比一个只有小红点的铃铛准。 */}
        <div className="rail-foot">
          {/* AI 跑完了没有：跑着一条细进度，答完一行字、3 秒自己走。点一条回原处。
              人切去别的应用了则由桌面端发系统通知（desktop/main.js 的 notify:show） */}
          {/* AI 面板收着时的入口。原来是正文右边一条 44px 的窄边，笔记本上每张表都被它挤掉最右一列，
              挪到这里就哪边都不占（见 AiDock 收起时那段）。首页就是对话本身，不用它 */}
          {ai && !小屏 && !面板开着 && 底下那页 !== "/dashboard" && (
            <button type="button" className="rail-item rail-ask" onClick={() => 记住面板(true)} aria-label="打开 AI 面板（Ctrl+J / ⌘J）">
              <MessageOutlined />
              <b>问一句</b>
              <span className="rail-ask-k"><Shortcut>⌘J</Shortcut></span>
            </button>
          )}
          <AiTasks />
          <AiMeterBar />
          {/* 检查更新那一行（学 MonoCode 左下角）：常驻，写着当前版本；有新版变蓝、下载有进度、下好了点它重启 */}
          {desktop && <UpdateRow />}
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
            {/* 更新之后的「新」：原型里就在账号这一行右端（检查更新那一行在上面，管的是「有没有更新的版本」） */}
            {desktop && <WhatsNew 全部开着={更新记录开着} 关全部={() => set更新记录开着(false)} />}
            {/* 反馈在更新键的右边，两枚都是这一行的「出口」：一个往外拿新版本，一个往外送一句话。
                网页版没有更新键，那儿就只有它一枚 */}
            <FeedbackButton 去向={反馈去向} />
          </div>
        </div>
        {/* 右边那条能拖的缝。它贴着分隔线，平时看不见，指上去才显出来 */}
        <RailResizer />
      </nav>

      {/* ⌘K：跳页或问一句。挂在壳上，哪一页都在 */}
      <CommandBar />


      {/* 中栏：槽位自己带 <aside class="pane">，没有中栏的路由返回 null */}
      {pane}

      {/* antd 的 Content 自己就渲染成 <main>，外面不能再包一层：
          一个文档只能有一个 main，两个会让读屏和测试都认不出正文是哪块 */}
      <main className="main app-content" style={{ padding: "22px 26px" }}>
        {/*
          换页时正文淡进来、抬 6px。**--t（180ms），而且只有正文**——
          左栏和中栏不动，动的只是"这一页的内容换了"这件事本身。
          在这之前换页是硬切：上一页的表格原地变成下一页的表格，人得自己确认屏幕真的换了。

          key 挂在底下那页上：同一页里改筛选、翻页走的是 query，不会重来一遍；
          开设置浮层也不算换页——挂在 pathname 上的话，一开设置底下整页重挂、状态丢掉。
          超宽屏下限制正文宽度并居中，避免表格被拉得过于稀疏。
        */}
        <motion.div
          key={底下那页}
          initial={{ opacity: 0, y: 少动 ? 0 : 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 少动 ? 0 : 时长.base, ease: 曲线.ease }}
          style={{ maxWidth: 1720, margin: "0 auto" }}
        >
          <要跟Context.Provider value={要跟}>{children}</要跟Context.Provider>
        </motion.div>
      </main>
      {/*
        全局 AI 面板（⌘J）。挂在壳上所以切页不断流——正在跑的那一问跟着你走。
        它自己决定首页不出现（首页就是宽模式的同一块东西）。
        手机上不出现：390 宽摆不下正文 + 380 的面板。
      */}
      {ai && !小屏 && <AiDock userName={user.name} models={ai.models} 开着={面板开着} set开着={记住面板} />}
    </div>
    </DockOpenContext.Provider>
  );
}
