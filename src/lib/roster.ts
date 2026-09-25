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
 * 当前视口是不是窄到要把名单收起来。
 *
 * 1440 是记录页三栏（名单 220 + 正文 + AI 340）在 220 的左栏旁边还站得住的下限，
 * 再窄时间线就被压到三百出头，「下次跟进」那行字会竖排。
 */
export function useNarrow(查询: string) {
  const 订阅 = useCallback(
    (l: () => void) => {
      const mq = window.matchMedia(查询);
      mq.addEventListener("change", l);
      return () => mq.removeEventListener("change", l);
    },
    [查询],
  );
  return useSyncExternalStore(订阅, () => window.matchMedia(查询).matches, () => false);
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

/** 名单该不该收进抽屉：视口不够「名单 + 正文 + AI + 开着的面板」时收 */
export function useRosterInDrawer() {
  const 面板开着 = useContext(DockOpenContext);
  return useNarrow(`(max-width: ${1439 + (面板开着 ? DOCK_W : 0)}px)`);
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
