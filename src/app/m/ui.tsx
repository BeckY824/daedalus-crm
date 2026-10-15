"use client";

/**
 * 手机版的界面零件（2026-10-15，原型 /lab/m 定稿后搬过来）：页头、标签栏、底部面板、推入层、头像、标签、提示条。
 * 手感按两个平台的系统习惯：iPhone 大标题收成小标题、边缘右滑返回；安卓靠左顶栏、系统返回键。见 m.css。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useDragControls, useTransform, type MotionValue } from "motion/react";
import { 层样子, type 推入 } from "./push";
import { ArrowLeftOutlined, CalendarFilled, CalendarOutlined, CheckCircleFilled, CloseOutlined, CloudSyncOutlined, ContactsFilled, ContactsOutlined, DisconnectOutlined, ExclamationCircleFilled, LeftOutlined, PauseCircleFilled, RightOutlined, UploadOutlined } from "@ant-design/icons";
import { 简称, 头像色, 同步条 } from "@/lib/mobile/view";
import { 现状动效 } from "@/lib/motion";

export type 系统 = "ios" | "android";
export const 弹簧 = { type: "spring", stiffness: 420, damping: 42, mass: 0.9 } as const;

export function 猜系统(): 系统 {
  if (typeof navigator === "undefined") return "ios";
  return /android/i.test(navigator.userAgent) ? "android" : "ios";
}
/**
 * 认浏览器：国内的几个内核都写着 Chrome，得先认它们自己的标记（10-15 真机：夸克、华为、QQ、小米都被认成了 Chrome）。
 * 装到主屏幕的说明、电脑上显示的设备名都用它
 */
export type 浏览器 = "微信" | "QQ" | "QQ 浏览器" | "夸克" | "UC" | "华为浏览器" | "小米浏览器" | "OPPO 浏览器" | "vivo 浏览器" | "三星浏览器" | "Edge" | "Chrome" | "Safari" | "浏览器";
export function 认浏览器(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): 浏览器 {
  const 表: [RegExp, 浏览器][] = [
    [/MicroMessenger/, "微信"], [/ QQ\//, "QQ"], [/MQQBrowser/, "QQ 浏览器"], [/Quark\//, "夸克"], [/UCBrowser|UCWEB/, "UC"],
    [/HuaweiBrowser/, "华为浏览器"], [/MiuiBrowser/, "小米浏览器"], [/HeyTapBrowser/, "OPPO 浏览器"], [/VivoBrowser/, "vivo 浏览器"],
    [/SamsungBrowser/, "三星浏览器"], [/EdgA|EdgiOS/, "Edge"], [/CriOS|Chrome/, "Chrome"], [/Safari/, "Safari"],
  ];
  return 表.find(([re]) => re.test(ua))?.[1] ?? "浏览器";
}
/**
 * 确认能装到主屏幕的，各自菜单里怎么说（10-15 真机：华为浏览器 17 有「添加到桌面」；夸克 10.19、QQ 浏览器 20.6 没有）。
 * 不在表里的给通用说明
 */
const 装法: Partial<Record<浏览器, string>> = {
  Chrome: "浏览器菜单 ⋮ →「添加到主屏幕」或「安装应用」",
  Edge: "浏览器菜单 ⋮ →「添加到主屏幕」或「安装应用」",
  华为浏览器: "浏览器菜单里点「添加到桌面」",
};

export function 已装到主屏幕() {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}
export const 震一下 = () => { try { navigator.vibrate?.(8); } catch { /* iPhone 没有 */ } };

export const 状态色: Record<string, { fg: string; bg: string }> = {
  待跟进: { fg: "var(--text-muted)", bg: "var(--hover)" },
  跟进中: { fg: "var(--brand-deep)", bg: "var(--brand-bg)" },
  已加微信: { fg: "var(--brand-deep)", bg: "var(--brand-bg)" },
  意向较高: { fg: "var(--success-text)", bg: "var(--success-bg)" },
  已签约: { fg: "var(--success-text)", bg: "var(--success-bg)" },
  暂缓跟进: { fg: "var(--warning-text)", bg: "var(--warning-bg)" },
  已流失: { fg: "var(--danger-text)", bg: "var(--danger-bg)" },
};

export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  return <span className="m-avatar" style={{ width: size, height: size, background: 头像色(name), fontSize: size * 0.36 }}>{简称(name)}</span>;
}
export function StatusTag({ s }: { s: string }) {
  const c = 状态色[s] ?? 状态色.待跟进;
  return <span className="m-tag" style={{ color: c.fg, background: c.bg }}>{s}</span>;
}
/** 同步状态条。出了错（团队到期、没开通、同步没成功）给了 onOpen 就能点，点开看原因和怎么办 */
export function SyncChip({ 断网, 待同步, 上次成功, 错误, 现在, 在同步, onOpen }: {
  断网: boolean; 待同步: number; 上次成功: number | null; 错误: string | null; 现在: number; 在同步: boolean; onOpen?: () => void;
}) {
  const x = 同步条({ 断网, 待同步, 上次成功, 错误, 现在, 在同步 });
  const 图 = x.样子 === "ok" ? <CheckCircleFilled /> : x.样子 === "stop" ? <PauseCircleFilled /> : x.样子 === "off" ? (x.详 ? <ExclamationCircleFilled /> : <DisconnectOutlined />) : <CloudSyncOutlined />;
  const 类 = `m-sync${x.样子 === "ok" ? "" : ` is-${x.样子}`}`;
  if (x.详 && onOpen) return <button type="button" className={`${类} is-tap`} onClick={onOpen} data-testid="m-sync">{图} {x.字}<RightOutlined /></button>;
  return <span className={类} data-testid="m-sync">{图} {x.字}</span>;
}

/** iPhone：大标题，往上滚收成顶栏小标题；安卓：标题靠左的顶栏。吸顶（搜索框）放在页头里，大标题在它上面 */
export function Page({ os, 标题, 副标题, 右, 返回, 返回字, 吸顶, children, onRefresh, 底部 }: {
  os: 系统; 标题: string; 副标题?: ReactNode; 右?: ReactNode; 返回?: () => void; 返回字?: string; 吸顶?: ReactNode;
  children: ReactNode; onRefresh?: () => Promise<void>; 底部?: ReactNode;
}) {
  const [卷, set卷] = useState(false);
  const 滚 = useRef<HTMLDivElement>(null);
  const [拉, set拉] = useState(0);
  const [刷新中, set刷新中] = useState(false);
  const 起 = useRef<number | null>(null);

  const onTouchStart = (e: React.TouchEvent) => { if (onRefresh && 滚.current && 滚.current.scrollTop <= 0 && !刷新中) 起.current = e.touches[0].clientY; };
  const onTouchMove = (e: React.TouchEvent) => {
    if (起.current == null) return;
    const d = e.touches[0].clientY - 起.current;
    set拉(d <= 0 ? 0 : Math.min(90, d * 0.45));
  };
  const onTouchEnd = async () => {
    if (起.current == null) return;
    起.current = null;
    if (拉 > 56 && onRefresh) { set刷新中(true); set拉(52); 震一下(); await onRefresh().catch(() => undefined); set刷新中(false); }
    set拉(0);
  };

  return (
    <div className={`m-page-shell${卷 ? " is-scrolled" : ""}`}>
      <header className="m-nav">
        <div className="m-nav-row">
          {返回 && (
            <button className="m-back" onClick={返回} aria-label="返回">
              {os === "ios" ? <><LeftOutlined /><span>{返回字}</span></> : <ArrowLeftOutlined />}
            </button>
          )}
          <div className="m-nav-title">{标题}</div>
          <div className="m-nav-right">{右}</div>
        </div>
        {吸顶 && <div className="m-large m-large-in-nav"><h1>{标题}</h1></div>}
        {吸顶}
      </header>
      <div className="m-scroll" ref={滚} onScroll={(e) => set卷((e.target as HTMLDivElement).scrollTop > 28)}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
        {onRefresh && (
          <div className="m-ptr" style={{ height: 拉, opacity: Math.min(1, 拉 / 50) }}>
            <span className={`m-spinner${刷新中 ? " is-on" : ""}`} style={{ transform: `rotate(${拉 * 4}deg)` }} />
          </div>
        )}
        {!吸顶 && (
          <div className="m-large">
            <h1>{标题}</h1>
            {副标题 && <div className="m-large-sub">{副标题}</div>}
          </div>
        )}
        {children}
        <div className="m-bottom-pad" />
      </div>
      {底部}
    </div>
  );
}

/** 底下那一层（今天 / 客户）。p：0 = 详情完全进来，1 = 完全退回（push.ts） */
export function BaseLayer({ p, 宽, os, 少动, 有详情, children }: { p: MotionValue<number>; 宽: number; os: 系统; 少动: boolean; 有详情: boolean; children: ReactNode }) {
  const x = useTransform(p, (v) => (有详情 ? 层样子(v, 宽, os, 少动).底x : 0));
  const 暗 = useTransform(p, (v) => (有详情 ? 层样子(v, 宽, os, 少动).暗 : 0));
  return (
    <motion.div className="m-layer m-base" style={{ x }} aria-hidden={有详情}>
      {children}
      <motion.div className="m-dim" style={{ opacity: 暗 }} />
    </motion.div>
  );
}
/**
 * 推进来的那一层（客户详情）。iPhone 左边缘一条右滑返回；拖动自己管（不用 motion 的 drag：
 * 它一按下就停掉正在跑的推入动画，没拖就松开会停在半路，见 push.ts）
 */
export function TopLayer({ p, 宽, os, 少动, 推, 退着, children }: { p: MotionValue<number>; 宽: number; os: 系统; 少动: boolean; 推: 推入; 退着: boolean; children: ReactNode }) {
  const x = useTransform(p, (v) => 层样子(v, 宽, os, 少动).顶x);
  const 透明 = useTransform(p, (v) => 层样子(v, 宽, os, 少动).顶透明);
  const 按下 = (e: React.PointerEvent) => {
    if (!e.isPrimary) return;
    推.按下(e.clientX);
    const 移 = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) 推.移动(ev.clientX); };
    const 完 = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId && ev.type !== "pointercancel") return;
      if (ev.type === "pointerup") 推.松手(ev.clientX); else 推.取消();
      window.removeEventListener("pointermove", 移, true);
      window.removeEventListener("pointerup", 完, true);
      window.removeEventListener("pointercancel", 完, true);
    };
    // 挂在 window 的捕获阶段：手指滑出这条边、子元素拦了事件，都收得到松手和取消
    window.addEventListener("pointermove", 移, true);
    window.addEventListener("pointerup", 完, true);
    window.addEventListener("pointercancel", 完, true);
  };
  return (
    <motion.div className={`m-layer m-top${退着 ? " is-leaving" : ""}`} style={{ x, opacity: 透明 }} aria-hidden={退着}>
      {os === "ios" && <div className="m-edge" onPointerDown={按下} />}
      {children}
    </motion.div>
  );
}
export function Sheet({ onClose, children, 高 }: { onClose: () => void; children: ReactNode; 高: "auto" | "tall" }) {
  const 拖 = useDragControls();
  return (
    <>
      <motion.div className="m-scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 现状动效.时长.base }} />
      <motion.div className={`m-sheet m-sheet-${高}`} role="dialog"
        initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={弹簧}
        drag="y" dragListener={false} dragControls={拖} dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0.05, bottom: 0.9 }}
        onDragEnd={(_, i) => { if (i.offset.y > 120 || i.velocity.y > 600) onClose(); }}>
        <div className="m-grab" onPointerDown={(e) => 拖.start(e)}><span /></div>
        {children}
      </motion.div>
    </>
  );
}

export type 标签 = "today" | "customers";
export function TabBar({ os, tab, onTab, 今天数 }: { os: 系统; tab: 标签; onTab: (t: 标签) => void; 今天数: number }) {
  const 项 = [
    { k: "today" as const, 名: "今天", 图: tab === "today" ? <CalendarFilled /> : <CalendarOutlined />, 数: 今天数 },
    { k: "customers" as const, 名: "客户", 图: tab === "customers" ? <ContactsFilled /> : <ContactsOutlined /> },
  ];
  return (
    <nav className="m-tabbar" data-os={os}>
      {项.map((x) => (
        <button key={x.k} className={tab === x.k ? "is-on" : ""} onClick={() => onTab(x.k)} aria-current={tab === x.k ? "page" : undefined}>
          <span className="m-tab-ic">{x.图}{x.数 ? <em>{x.数 > 99 ? "99+" : x.数}</em> : null}</span>
          <span className="m-tab-l">{x.名}</span>
        </button>
      ))}
    </nav>
  );
}

export function InstallHint({ os, onClose }: { os: 系统; onClose: () => void }) {
  const [事件, set事件] = useState<(Event & { prompt?: () => void }) | null>(null);
  const [器] = useState(() => 认浏览器());
  useEffect(() => {
    const on = (e: Event) => { e.preventDefault(); set事件(e as Event & { prompt?: () => void }); };
    window.addEventListener("beforeinstallprompt", on);
    return () => window.removeEventListener("beforeinstallprompt", on);
  }, []);
  return (
    <div className="m-install">
      {/* eslint-disable-next-line @next/next/no-img-element -- 小图标，不走图片优化 */}
      <img src="/icon.svg" alt="" />
      <div className="m-install-t">
        <b>装到主屏幕，用起来像 App</b>
        {器 === "微信" || 器 === "QQ"
          ? <span>{器}里装不到桌面：点右上角「···」，在{os === "ios" ? " Safari " : "浏览器"}里打开后再装</span>
          : os === "ios"
          ? <span>点底部的 <UploadOutlined /> 分享，再点「添加到主屏幕」</span>
          : 事件 ? <span>不用去应用商店，点右边就装好</span>
          : 装法[器] ? <span>{装法[器]}</span>
          : <>
              <span>菜单里找「添加到桌面」；没有的话，用 Chrome 或 Edge 打开这个网址再装。不装也能直接用</span>
              <small>点了没反应：在手机设置里给这个浏览器打开「创建桌面快捷方式」权限</small>
            </>}
      </div>
      {os === "android" && 事件 ? <button className="m-btn m-btn-sm" onClick={() => 事件.prompt?.()}>安装</button> : null}
      <button className="m-icon-btn" onClick={onClose} aria-label="关掉"><CloseOutlined /></button>
    </div>
  );
}
