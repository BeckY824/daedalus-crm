"use client";

import { Button } from "antd";
import { ReloadOutlined } from "@ant-design/icons";

/**
 * 列表筛选栏最后那颗「重置」。**位置一直留着**，没筛的时候只是看不见、点不到。
 *
 * 2026-09-28 审查 M17：原来它筛了才出现，一出现就把「列」挤到第二行，整张表往下跳 37px——
 * 人刚选完一个状态，眼睛盯着的那一行就挪走了。留位之后筛不筛表头都在同一个高度；
 * 出现、消失只是淡入淡出（--t-fast），不位移，减弱动态下也一样。
 * 看不见的时候不进 Tab 顺序、读屏也跳过：它此刻不是一个能用的东西。
 */
export default function ResetFilters({ 显示, onClick }: { 显示: boolean; onClick: () => void }) {
  return (
    <Button
      icon={<ReloadOutlined />}
      onClick={onClick}
      className={`list-reset${显示 ? "" : " is-off"}`}
      aria-hidden={!显示}
      tabIndex={显示 ? 0 : -1}
    >
      重置
    </Button>
  );
}
