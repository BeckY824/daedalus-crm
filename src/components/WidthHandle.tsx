"use client";
/**
 * 一条能拖的缝。左栏那条（RailResizer）证明了这件事值得做，现在它有三处要用：
 * 左栏、首页的对话列表、右边的 AI 面板。
 *
 * **为什么值得做**：这些栏装的是名字和句子，而长度不是我们定的——
 * 「意向学员回访计划」和「A 渠道」需要的宽度差一倍。默认值是折中值，
 * 折中值对谁都不是刚好，所以把最后一寸交给用它的人。
 *
 * 宽度写在 :root 的 CSS 变量上，存 localStorage：一台机器上定一次就算数。
 * **不上云**——它是这块屏幕的事，换台电脑换个屏幕，合适的宽度本来就该不一样。
 *
 * 双击 / Home 回默认；方向键一次 8px——一条只能用鼠标拖的缝，
 * 等于对用键盘的人不存在。
 */
import { useCallback, useEffect, useRef } from "react";

export type 把手规格 = {
  /** CSS 变量名，如 --rail-w。宽度最终写在 :root 上 */
  变量: string;
  /** localStorage 的键 */
  存档键: string;
  默认: number;
  最窄: number;
  最宽: number;
  /** 量当前宽度用的选择器 */
  量: string;
  /**
   * 缝在那一栏的哪一边。右边（左栏、中栏）往右拖变宽；
   * 左边（右侧面板）往**左**拖才变宽——它贴着窗口右缘，往右没地方去了
   */
  边: "右" | "左";
  aria: string;
};

export default function WidthHandle({ 规格 }: { 规格: 把手规格 }) {
  const { 变量, 存档键, 默认, 最窄, 最宽, 量, 边, aria } = 规格;
  const 起 = useRef<{ x: number; w: number } | null>(null);

  const 夹住 = useCallback((px: number) => Math.max(最窄, Math.min(最宽, Math.round(px))), [最窄, 最宽]);

  const 应用 = useCallback(
    (px: number | null) => {
      const root = document.documentElement;
      if (px == null) root.style.removeProperty(变量);
      else root.style.setProperty(变量, `${px}px`);
    },
    [变量],
  );

  useEffect(() => {
    try {
      const 存的 = Number(localStorage.getItem(存档键));
      if (存的) 应用(夹住(存的));
    } catch {
      // 隐私模式下读不到就用默认宽度，不值得为它报错
    }
  }, [存档键, 应用, 夹住]);

  const 当前宽 = useCallback(() => document.querySelector(量)?.getBoundingClientRect().width ?? 默认, [量, 默认]);

  const 定住 = useCallback(
    (px: number | null) => {
      应用(px);
      try {
        if (px == null) localStorage.removeItem(存档键);
        else localStorage.setItem(存档键, String(px));
      } catch {
        // 存不下就只在这一次会话里生效
      }
    },
    [应用, 存档键],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    起.current = { x: e.clientX, w: 当前宽() };
    e.currentTarget.setPointerCapture(e.pointerId);
    // 拖的时候别把字选中，也别让光标在跨过正文时变回箭头
    document.body.classList.add("rail-resizing");
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!起.current) return;
    const 位移 = e.clientX - 起.current.x;
    应用(夹住(起.current.w + (边 === "右" ? 位移 : -位移)));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!起.current) return;
    起.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove("rail-resizing");
    定住(夹住(当前宽()));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const 变 = (e.key === "ArrowRight" ? 8 : -8) * (边 === "右" ? 1 : -1);
      定住(夹住(当前宽() + 变));
    } else if (e.key === "Home") {
      e.preventDefault();
      定住(null);
    }
  };

  return (
    <div
      className={`rail-resizer${边 === "左" ? " rail-resizer-left" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={aria}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => 定住(null)}
      onKeyDown={onKeyDown}
    />
  );
}

/** 三处的规格摆在一起，改宽度上限时一眼看得全 */
export const 左栏把手: 把手规格 = { 变量: "--rail-w", 存档键: "rail-w", 默认: 220, 最窄: 180, 最宽: 360, 量: ".rail", 边: "右", aria: "调整左栏宽度（方向键微调，双击或 Home 回默认）" };
export const 对话列表把手: 把手规格 = { 变量: "--chat-w", 存档键: "chat-w", 默认: 232, 最窄: 180, 最宽: 420, 量: ".pane-chat", 边: "右", aria: "调整对话列表宽度（方向键微调，双击或 Home 回默认）" };
export const 面板把手: 把手规格 = { 变量: "--dock-w", 存档键: "dock-w", 默认: 380, 最窄: 300, 最宽: 560, 量: ".dock", 边: "左", aria: "调整 AI 面板宽度（方向键微调，双击或 Home 回默认）" };
