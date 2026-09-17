"use client";
/**
 * 左栏右边那条能拖的缝。
 *
 * **为什么值得做**：这一栏装的是模块名和人名，而名字的长度不是我们定的——
 * 「意向学员回访计划」和「A 渠道」需要的宽度差一倍。220 是个折中值，
 * 折中值对谁都不是刚好，所以把最后一寸交给用它的人。
 *
 * 宽度写在 :root 的 --rail-w 上（.rail 本来就按它取宽），存在 localStorage：
 * 一台机器上定一次就算数，不必每次开窗口重来。**不上云**——它是这块屏幕的事，
 * 换台电脑换个屏幕，合适的宽度本来就该不一样。
 *
 * 双击回到默认；键盘上左右方向键一次 8px（Home 回默认）——
 * 一条只能用鼠标拖的缝，等于对用键盘的人不存在。
 */
import { useCallback, useEffect, useRef } from "react";

const 存档键 = "rail-w";
const 默认 = 220;
const 最窄 = 180;
const 最宽 = 360;

const 夹住 = (px: number) => Math.max(最窄, Math.min(最宽, Math.round(px)));

function 应用(px: number | null) {
  const root = document.documentElement;
  if (px == null) root.style.removeProperty("--rail-w");
  else root.style.setProperty("--rail-w", `${px}px`);
}

export default function RailResizer() {
  const 起 = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    try {
      const 存的 = Number(localStorage.getItem(存档键));
      if (存的) 应用(夹住(存的));
    } catch {
      // 隐私模式下读不到就用默认宽度，不值得为它报错
    }
  }, []);

  const 当前宽 = () =>
    document.querySelector(".rail")?.getBoundingClientRect().width ?? 默认;

  const 定住 = useCallback((px: number | null) => {
    应用(px);
    try {
      if (px == null) localStorage.removeItem(存档键);
      else localStorage.setItem(存档键, String(px));
    } catch {
      // 存不下就只在这一次会话里生效
    }
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    起.current = { x: e.clientX, w: 当前宽() };
    e.currentTarget.setPointerCapture(e.pointerId);
    // 拖的时候别把侧栏的字选中，也别让光标在跨过正文时变回箭头
    document.body.classList.add("rail-resizing");
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!起.current) return;
    应用(夹住(起.current.w + (e.clientX - 起.current.x)));
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
      定住(夹住(当前宽() + (e.key === "ArrowRight" ? 8 : -8)));
    } else if (e.key === "Home") {
      e.preventDefault();
      定住(null);
    }
  };

  return (
    <div
      className="rail-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整左栏宽度（方向键微调，双击或 Home 回默认）"
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
