"use client";

/**
 * 中栏（记录页的客户名单、首页的对话列表）收起 / 打开（2026-10-19 用户定的方案）。
 *
 * 两种「不在」要分开记：
 *   - 人自己点了收起 —— 记在这台电脑上（useLocalPref，不上云），窗口拉多宽都保持收着，直到人再点开；
 *   - 窗口太窄放不下 —— 不记，窗口拉宽回来它自己回来。
 * 不在的时候它是一只抽屉（从左边滑出、点外面关），开它的是主区页头最左边那颗同样的图标。
 *
 * 快捷键 ⌘\（Windows 是 Ctrl+\）切换；记录页的 ⌘K「换一位」照旧，名单不在时打开抽屉、光标进搜索框。
 */
import { useCallback, useEffect } from "react";
import { useLocalPref } from "@/lib/local-pref";
import { useNarrow, useDrawerOpen, useRosterInDrawer, 设抽屉, type 中栏 } from "@/lib/roster";

export type { 中栏 };

/**
 * 首页对话列表放不下的宽度：左栏 220 + 列表 232 + 问答区留够 640（问候那行和输入框不折得难看）。
 * 记录页名单的门槛在 lib/roster.ts（名单门槛，还要算上右边 AI 面板开没开）
 */
export const 对话列表门槛 = 220 + 232 + 640;

export function useMiddlePane(栏: 中栏) {
  const [收着, set收着] = useLocalPref<boolean>(`pane.${栏}.collapsed`, false);
  const 名单太窄 = useRosterInDrawer();
  const 列表太窄 = useNarrow(`(max-width: ${对话列表门槛 - 1}px)`);
  const 太窄 = 栏 === "roster" ? 名单太窄 : 列表太窄;
  const 抽屉开着 = useDrawerOpen(栏);
  /** 中栏现在是不是一整栏摆在那儿（不是抽屉） */
  const 露着 = !太窄 && !收着;

  /** 中栏页头（或抽屉页头）上那颗：收起 / 关抽屉 */
  const 收 = useCallback(() => {
    if (露着) set收着(true);
    else 设抽屉(栏, false);
  }, [露着, set收着, 栏]);
  /** 主区页头上那颗：太窄时开关抽屉，否则把人收起的那栏放回来 */
  const 放 = useCallback(() => {
    if (太窄) 设抽屉(栏, !抽屉开着);
    else {
      设抽屉(栏, false);
      set收着(false);
    }
  }, [太窄, 抽屉开着, set收着, 栏]);
  const 切换 = useCallback(() => (露着 || 抽屉开着 ? 收() : 放()), [露着, 抽屉开着, 收, 放]);

  // 放回整栏了，抽屉就不该还开着（比如抽屉开着时把窗口拉宽）
  useEffect(() => {
    if (露着 && 抽屉开着) 设抽屉(栏, false);
  }, [露着, 抽屉开着, 栏]);

  return { 露着, 太窄, 收着, 抽屉开着, 收, 放, 切换, 收起: () => set收着(true) };
}

/** ⌘\ / Ctrl+\：中栏自己挂（它在哪一页就是哪一页的） */
export function usePaneShortcut(切换: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "\\" && e.code !== "Backslash") return;
      e.preventDefault();
      切换();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [切换]);
}
