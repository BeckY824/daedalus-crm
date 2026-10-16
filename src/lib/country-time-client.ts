"use client";

/**
 * 「对方当地 14:05」在页面上跟着走（2026-10-16）。整页共用一个每分钟跳一次的钟：列表里几十行各开一个定时器没必要。
 * 服务端那一版不画时间（快照给 0）：服务端和浏览器差几秒就会对不上，水合报错；进了浏览器再补上。
 */
import { useSyncExternalStore } from "react";
import { 对方当地, type 当地时间 } from "./country-time";

let 现在分 = 0;
const 听的 = new Set<() => void>();
let 钟: ReturnType<typeof setTimeout> | null = null;

function 下一分() {
  现在分 = Math.floor(Date.now() / 60_000);
  听的.forEach((f) => f());
  钟 = setTimeout(下一分, 60_000 - (Date.now() % 60_000) + 50);
}

function 订阅(f: () => void) {
  听的.add(f);
  if (!钟) {
    现在分 = Math.floor(Date.now() / 60_000);
    钟 = setTimeout(下一分, 60_000 - (Date.now() % 60_000) + 50);
  }
  return () => {
    听的.delete(f);
    if (!听的.size && 钟) {
      clearTimeout(钟);
      钟 = null;
    }
  };
}

/** 当前是第几分钟（服务端 0）。拿来当依赖，分钟一变就重算 */
export function useMinuteTick(): number {
  return useSyncExternalStore(订阅, () => 现在分 || Math.floor(Date.now() / 60_000), () => 0);
}

/** 这个国家此刻几点；服务端、认不出国家、和本机同一钟点时 null */
export function useCountryLocalTime(国家: string | null | undefined): 当地时间 | null {
  const 分 = useMinuteTick();
  return 分 ? 对方当地(国家, new Date(分 * 60_000)) : null;
}
