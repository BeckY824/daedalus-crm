"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { animate, useReducedMotion } from "motion/react";

/**
 * 从 0 滚到这个数。**只滚第一次**。
 *
 * 为什么值得有：首页那一行信号是「这一刻真查出来的」，滚一下说的就是这件事——
 * 数字是刚数出来的，不是一张贴在那儿的图。
 * 为什么只滚一次：翻回首页、切个页签就重滚一遍，第二次之后它就只是噪音了。
 * 记号相同的那一个数，这次会话里只滚一次（刷新页面重新开始，这正好——那是新的一次打开）。
 *
 * 服务端渲染出来的是**最终值**，不是 0：万一 JS 没跑起来，页面上留下的得是真的数，
 * 而不是一个永远停在 0 的谎。滚动在挂载后的同一帧里接管（useLayoutEffect），所以看不见跳。
 */
const 滚过的 = new Set<string>();

/** useLayoutEffect 在服务端会告警；SSR 时退回 useEffect（那一趟本来也不跑动画） */
const 同步副作用 = typeof window === "undefined" ? useEffect : useLayoutEffect;

export default function CountUp({
  值,
  记号,
  格式 = (n) => String(Math.round(n)),
  时长 = 0.6,
}: {
  值: number;
  /** 这个数在页面上的身份，用来记「滚过了」。比如 "signal:逾期" */
  记号: string;
  格式?: (n: number) => string;
  时长?: number;
}) {
  const 少动 = useReducedMotion();
  const [显示, set显示] = useState(值);

  同步副作用(() => {
    // 0 没什么可滚的；滚过了就不再滚
    if (少动 || 值 === 0 || 滚过的.has(记号)) {
      set显示(值);
      return;
    }
    滚过的.add(记号);
    set显示(0);
    const 控制 = animate(0, 值, {
      duration: 时长,
      ease: [0.2, 0.8, 0.2, 1],
      onUpdate: set显示,
      onComplete: () => set显示(值),
    });
    return () => 控制.stop();
  }, [值, 记号, 少动, 时长]);

  return <>{格式(显示)}</>;
}
