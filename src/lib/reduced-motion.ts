"use client";

import { useSyncExternalStore } from "react";

/**
 * 系统「减弱动态」开没开。原来登录页、手机端各写一份订阅，记录页、计划页各自现读，四处一个意思。
 *
 * 不用 motion 的 useReducedMotion：它在服务端是 null、到浏览器第一下就是真值，开了「减弱动态」的人
 * 每次进页都 hydration 对不上，React 把整块丢掉重画；它也不跟着中途改系统设置走。
 * 这里服务端和水合那一下按 服务端 给的值算（默认「没开」），水合完再换真值，之后跟着系统设置变。
 */
export const 少动查询 = "(prefers-reduced-motion: reduce)";

const 订 = (cb: () => void) => {
  const m = window.matchMedia(少动查询);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const 读 = () => window.matchMedia(少动查询).matches;

export function useSystemReducedMotion(服务端 = false) {
  return useSyncExternalStore(订, 读, () => 服务端);
}

/** 这一刻开没开——点击、进页滚动这类一次性的地方现读，不用订阅 */
export function 少动(): boolean {
  return typeof window !== "undefined" && 读();
}

/** scrollIntoView 的 behavior：开了「减弱动态」直接跳过去，不滑 */
export function 滚法(): ScrollBehavior {
  return 少动() ? "auto" : "smooth";
}
