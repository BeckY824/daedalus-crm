"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";

/**
 * 盖在页面上的那几层浮层的地址。现在只有设置（拦截路由 app/(app)/@modal/(.)settings）。
 * 加了新的浮层要登记在这儿，不然它一开，底下那页就会被当成换了一页。
 */
export const 浮层地址 = ["/settings"];

/**
 * **底下那一页**的地址——浮层开着时，是被盖住的那页，不是地址栏。
 *
 * 拦截路由的代价：设置一开，`usePathname()` 就变成 /settings，
 * 而底下画着的还是刚才那页。壳和 AI 面板要是照地址栏判断，就会以为换了一页：
 *   - 从首页开设置，右边冒出 AI 面板（它只该在首页以外的页出现）——2026-09-28 用户报的
 *   - 正文那层 `key={pathname}` 一变，底下的首页整个重挂一遍：淡入重放，手里的状态丢掉
 *   - AI 面板的「这一页」上下文和对话范围跳到「设置」上去
 *
 * 做法是记住最近一次不是浮层的地址。刷新或直接打开 /settings 时没有「上一页」
 * （那是硬导航，落到的是整页设置），这时就老实返回 /settings。
 *
 * 在 render 里按条件 setState 是 React 认可的「由 props 派生 state」写法，
 * 不需要一个「pathname 变了就 setState」的 effect（那会多渲染一遍，eslint 也不让）。
 */
export function usePageUnderOverlay(): string {
  const pathname = usePathname();
  const [上一页, set上一页] = useState<string | null>(null);
  const 是浮层 = 浮层地址.includes(pathname);
  if (!是浮层 && pathname !== 上一页) set上一页(pathname);
  return 是浮层 && 上一页 ? 上一页 : pathname;
}
