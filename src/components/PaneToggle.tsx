"use client";

/**
 * 中栏开关（2026-10-19 用户定的方案，学访达 / Notion 的侧栏按钮）。
 *
 * 同一颗图标摆两处：中栏页头右边（点了收起），收起后出现在主区页头最左边（点了打开）——
 * 两处离得近，手不用找。窗口太窄时中栏收成抽屉，主区这颗就是开抽屉的；
 * 原来记录页上那颗「换一位（⌘K）」文字按钮去掉了，统一成它。
 */
import { Tooltip } from "antd";
import Shortcut from "@/components/Shortcut";
import { useBusiness } from "@/lib/business-client";
import { useMiddlePane, type 中栏 } from "@/lib/middle-pane";

function 侧栏图标() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M6.25 2.75v10.5" />
    </svg>
  );
}

export default function PaneToggle({ 栏, 位置, className }: { 栏: 中栏; 位置: "中栏" | "主区"; className?: string }) {
  const b = useBusiness();
  const p = useMiddlePane(栏);
  // 主区那颗只在中栏不在时出现；中栏那颗跟着中栏（整栏或抽屉）走
  if (位置 === "主区" && p.露着) return null;
  const 名 = 栏 === "roster" ? `${b.customer}名单` : "对话列表";
  const 开着 = 位置 === "中栏" ? true : p.抽屉开着;
  const 说 = `${开着 ? "隐藏" : "显示"}${名}`;
  return (
    <Tooltip
      title={
        <span className="pane-toggle-tip">
          {说}
          <kbd>
            <Shortcut>⌘\</Shortcut>
          </kbd>
        </span>
      }
      mouseEnterDelay={0.4}
    >
      <button
        type="button"
        className={`pane-ib pane-toggle${className ? ` ${className}` : ""}`}
        aria-label={说}
        aria-expanded={开着}
        onClick={位置 === "中栏" ? p.收 : p.放}
      >
        <侧栏图标 />
      </button>
    </Tooltip>
  );
}
