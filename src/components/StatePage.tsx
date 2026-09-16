"use client";

import { Button } from "antd";

/**
 * 出错、404、空——这三种「页面上没有正文」的状态长同一个样子。
 *
 * 规矩是一样的三件事：**发生了什么、为什么、接下来做什么**，外加一个能点的动作。
 * 「页面出错了」「404」「暂无数据」这类只说了第一件，剩下两件留给人猜。
 *
 * 样式直接借空状态那一套（.empty-state），所以四态在视觉上是一件事，
 * 不是三个人各画一个。空状态本身在 components/EmptyState.tsx——
 * 它多一层「灌演示数据」的判断，不并进来。
 */
export default function StatePage({
  标题,
  说明,
  动作,
  次动作,
  附注,
}: {
  标题: string;
  /** 一句话说清：发生了什么、为什么、接下来做什么 */
  说明: React.ReactNode;
  动作?: { label: string; onClick?: () => void; href?: string };
  次动作?: { label: string; onClick?: () => void; href?: string };
  /** 错误编号这类给管理员看的东西 */
  附注?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-t">{标题}</div>
      <p className="empty-state-h">{说明}</p>
      <div className="empty-state-a">
        {动作 && (
          <Button type="primary" href={动作.href} onClick={动作.onClick}>
            {动作.label}
          </Button>
        )}
        {次动作 && (
          <Button href={次动作.href} onClick={次动作.onClick}>
            {次动作.label}
          </Button>
        )}
      </div>
      {附注 && <p className="empty-state-h" style={{ marginTop: 12 }}>{附注}</p>}
    </div>
  );
}
