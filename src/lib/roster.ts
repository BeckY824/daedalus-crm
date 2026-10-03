"use client";

/**
 * 窄名单（记录页左边那条「最近跟进的 50 位」）在窄屏下收成抽屉之后，
 * 开关它的按钮在记录页的页头上，名单本身在并行路由的槽位里——
 * 两边不是父子关系，靠这个小仓库通气。
 *
 * 和 ai-jobs 一样是模块级的，只活在这个页面进程里：整页刷新即关闭。
 */
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type RefObject } from "react";

/* 这两个 hook 的名字是英文的：react-hooks 那条规则按「use + 大写字母」认 hook，
   写成 use名单开着 它根本不当 hook 看，整条规则对调用它的文件就失效了 */

let 开着 = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function 开名单() {
  开着 = true;
  notify();
}
export function 关名单() {
  开着 = false;
  notify();
}

/**
 * ⌘K 在记录页上是「换一位」（审查 M8）。
 *
 * 原来名单自己在 window 上听 ⌘K，跳转单（CommandBar）也听，一按两响：名单的搜索框和
 * 跳转单同时抢焦点，最后落在谁身上不确定。现在 **⌘K 只有 CommandBar 一个人听**，
 * 名单在的时候把「换一位」登记在这里，CommandBar 先问一句「这一页有没有人接」。
 */
let 换一位处理: (() => void) | null = null;
export function 登记换一位(fn: () => void): () => void {
  换一位处理 = fn;
  const 放 = 登记页内占用();
  return () => {
    if (换一位处理 === fn) 换一位处理 = null;
    放();
  };
}

/**
 * 这一页有没有把 ⌘K 占走（2026-10-03 走查）。左栏顶上的搜索框写着「⌘K」，
 * 可首页的 ⌘K 是「光标回问答框」、记录页的 ⌘K 是「换一位」——标签说的和按下去的不是一回事。
 * 行为是定过的（见 CommandBar 文件头、审查 M8），所以改的是标签：有页面占着 ⌘K 时左栏不写它。
 * 占用的是名单（登记换一位）和页内的问答框（AskBox，右边面板里那个不算）。按次数记，挂几个卸几个
 */
let 页内占用 = 0;
const 占用听 = new Set<() => void>();
export function 登记页内占用(): () => void {
  页内占用++;
  占用听.forEach((l) => l());
  let 放过 = false;
  return () => {
    if (放过) return;
    放过 = true;
    页内占用--;
    占用听.forEach((l) => l());
  };
}
export function usePageOwnsCmdK(): boolean {
  return useSyncExternalStore(
    (l) => {
      占用听.add(l);
      return () => 占用听.delete(l);
    },
    () => 页内占用 > 0,
    () => false,
  );
}
/** 这一页有人接「换一位」就交给它，返回 true；没有返回 false，照常开跳转单 */
export function 换一位(): boolean {
  if (!换一位处理) return false;
  换一位处理();
  return true;
}

export function useRosterOpen() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => 开着,
    () => false,
  );
}

/**
 * 这条媒体查询命中没有（窗口够不够宽）。
 * 服务端不知道窗口多宽，水合前先给 服务端 那个值，之后换成真的。
 */
export function useNarrow(查询: string, 服务端 = false) {
  const 订阅 = useCallback(
    (l: () => void) => {
      const mq = window.matchMedia(查询);
      mq.addEventListener("change", l);
      return () => mq.removeEventListener("change", l);
    },
    [查询],
  );
  return useSyncExternalStore(订阅, () => window.matchMedia(查询).matches, () => 服务端);
}

/**
 * 全局 AI 面板（右边那条「问一句」）开着没有，由 AppShell 提供。
 *
 * 视口断点不知道它的存在：1440 的窗口开着面板，正文只剩 1440 - 220 - 380 ≈ 840，
 * 断点还以为自己有 1440，名单和记录页的 AI 栏照摆，时间线被挤成一条缝、字竖着排
 * （2026-09-25 录教程时实地撞到）。所以名单的断点要把面板那 380 加回去。
 */
export const DockOpenContext = createContext(false);
/** 和 globals.css 的 --dock-w 是同一个数 */
export const DOCK_W = 380;

/**
 * 名单该不该收进抽屉：视口放不下「左栏 + 名单 + 记录页两栏（资料 + 时间线）」时收。
 *
 * 2026-10-03 照毛玻璃原型改：「左栏 + 名单 + 详情」三栏是桌面端的主场，名单优先于记录页右边那条 AI 栏——
 * 窗口不够宽时先把 AI 栏收成按钮（记录页按正文实际宽度自己收，< 908），名单留着。
 * 原来的门槛是 1440（名单 + 资料 + 时间线 + AI 四列都摆得下），可 13/15 寸 Mac 屏幕本身才 1440–1470 宽，
 * 窗口几乎到不了，名单等于永远在抽屉里。
 * 1214 = 左栏 220 + 名单 312 + 正文留白 52 + 记录页两栏的下限 630（再窄就成单栏）。
 */
export const 名单门槛 = 220 + 312 + 52 + 630;
export function useRosterInDrawer() {
  const 面板开着 = useContext(DockOpenContext);
  return useNarrow(`(max-width: ${名单门槛 - 1 + (面板开着 ? DOCK_W : 0)}px)`);
}

/**
 * 一个元素实际有多宽（没量到之前是 null）。
 * 记录页用它决定 AI 栏收不收：看的是正文**真的**有多宽，名单、面板、窗口谁占了地方都算进去了。
 */
export function useWidth(ref: RefObject<HTMLElement | null>) {
  const [宽, set宽] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => set宽(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return 宽;
}
