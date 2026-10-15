"use client";

/**
 * 手机版的界面零件（2026-10-15，原型 /lab/m 定稿后搬过来）：页头、标签栏、底部面板、推入层、头像、标签、提示条。
 * 手感按两个平台的系统习惯：iPhone 大标题收成小标题、边缘右滑返回；安卓靠左顶栏、系统返回键。见 m.css。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, useDragControls, useTransform, type MotionValue } from "motion/react";
import { ArrowLeftOutlined, CalendarFilled, CalendarOutlined, CheckCircleFilled, CloseOutlined, CloudSyncOutlined, ContactsFilled, ContactsOutlined, DisconnectOutlined, LeftOutlined, UploadOutlined } from "@ant-design/icons";
import { 简称, 头像色, 相对时间 } from "@/lib/mobile/view";
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
/** 这几个确认能装到主屏幕（菜单里有，或者会弹安装）；其余的不一定有入口（夸克 10.19 菜单里就没有） */
const 能装 = new Set<浏览器>(["Chrome", "Edge", "三星浏览器"]);

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
export function SyncChip({ 断网, 待同步, 上次同步, 现在, 在同步 }: { 断网: boolean; 待同步: number; 上次同步: number | null; 现在: number; 在同步: boolean }) {
  if (断网) return <span className="m-sync is-off"><DisconnectOutlined /> 离线{待同步 ? ` · ${待同步} 条待同步` : ""}</span>;
  if (在同步 || 待同步) return <span className="m-sync is-wait"><CloudSyncOutlined /> {待同步 ? `${待同步} 条同步中` : "同步中"}</span>;
  if (!上次同步) return <span className="m-sync is-wait"><CloudSyncOutlined /> 还没同步</span>;
  return <span className="m-sync"><CheckCircleFilled /> 已同步 · {相对时间(上次同步, 现在)}</span>;
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

export function BaseLayer({ 顶x, 宽, os, 有详情, children }: { 顶x: MotionValue<number>; 宽: number; os: 系统; 有详情: boolean; children: ReactNode }) {
  const x = useTransform(顶x, (v) => (有详情 && os === "ios" ? (v / 宽 - 1) * 宽 * 0.28 : 0));
  const 暗 = useTransform(顶x, (v) => (有详情 ? (1 - v / 宽) * (os === "ios" ? 0.1 : 0) : 0));
  return (
    <motion.div className="m-layer m-base" style={{ x }} aria-hidden={有详情}>
      {children}
      <motion.div className="m-dim" style={{ opacity: 暗 }} />
    </motion.div>
  );
}

/** 推进来的那一层。iPhone：从左边缘往右拖返回，过了三分之一或甩得快就返回，否则弹回去 */
export function TopLayer({ 顶x, 宽, os, onBack, children }: { 顶x: MotionValue<number>; 宽: number; os: 系统; onBack: () => void; children: ReactNode }) {
  const 透明 = useTransform(顶x, [0, 宽 * 0.18], [1, 0]);
  const 拖 = useDragControls();
  return (
    <motion.div className="m-layer m-top" style={{ x: 顶x, opacity: os === "android" ? 透明 : 1 }}
      drag={os === "ios" ? "x" : false} dragListener={false} dragControls={拖} dragConstraints={{ left: 0, right: 宽 }} dragElastic={0} dragMomentum={false}
      onDragEnd={(_, i) => { if (i.offset.x > 宽 / 3 || i.velocity.x > 600) onBack(); else animate(顶x, 0, 弹簧); }}>
      {os === "ios" && <div className="m-edge" onPointerDown={(e) => 拖.start(e)} />}
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
          : 能装.has(器) ? <span>浏览器菜单 ⋮ →「添加到主屏幕」或「安装应用」</span>
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
