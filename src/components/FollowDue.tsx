"use client";
import { createContext, useContext } from "react";

/**
 * 要跟的数（逾期 + 今天到期、还没做的计划和待办），由 AppShell 从 layout 接过来往下传。
 * 左栏「跟进」、跟进记录页头上的「计划」按钮、手机顶栏铃铛都挂它——和 Dock 上的数一路对得上。
 */
export const 要跟Context = createContext<{ 逾期: number; 今天: number }>({ 逾期: 0, 今天: 0 });
export const useFollowDue = () => useContext(要跟Context);
