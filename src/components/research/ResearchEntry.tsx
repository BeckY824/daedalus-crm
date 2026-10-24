"use client";
/**
 * 这台机器摆不摆背调入口（服务端 lib/research/channel.ts 的 背调有入口 算好，layout 里传下来）。
 * 默认摆：没包这一层的地方（单测、别处挂的组件）照旧
 */
import { createContext, useContext } from "react";

const Ctx = createContext(true);

export const ResearchEntryProvider = Ctx.Provider;

export function useResearchEntry(): boolean {
  return useContext(Ctx);
}
