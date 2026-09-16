"use client";

/**
 * 窄名单（记录页左边那条「最近跟进的 50 位」）在窄屏下收成抽屉之后，
 * 开关它的按钮在记录页的页头上，名单本身在并行路由的槽位里——
 * 两边不是父子关系，靠这个小仓库通气。
 *
 * 和 ai-jobs 一样是模块级的，只活在这个页面进程里：整页刷新即关闭。
 */
import { useSyncExternalStore } from "react";

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
 * 1440 是记录页三栏（名单 220 + 正文 + AI 340）在 164 的左栏旁边还站得住的下限，
 * 再窄时间线就被压到三百出头，「下次跟进」那行字会竖排。
 */
export function useNarrow(查询: string) {
  return useSyncExternalStore(
    (l) => {
      const mq = window.matchMedia(查询);
      mq.addEventListener("change", l);
      return () => mq.removeEventListener("change", l);
    },
    () => window.matchMedia(查询).matches,
    () => false,
  );
}
