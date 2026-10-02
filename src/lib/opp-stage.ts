import { OPP_STAGES } from "./constants";

/**
 * 阶段和状态对齐：赢单成交 ⇔ WON（排查 C6）。**这一次人动的是哪一格，就听哪一格的**（2026-10-02 排查）。
 *
 * 原来只看单个字段：阶段是「赢单成交」就强制 WON、状态是 WON 就推回「赢单成交」。
 * 编辑一条已赢单的商机时，人只改状态（→ 丢单），阶段那格还是「赢单成交」，于是又被改回 WON；
 * 只改阶段（→ 谈判审核），状态那格还是 WON，又被推回赢单成交——两种改法都存不进去，界面却说「已保存」。
 * 「赢了的单后来黄了、改成丢单」在界面上根本做不到。
 *
 * 从赢单改走、阶段又没动的：阶段退回「赢单成交」前一档（丢单不限阶段，但不能挂在赢单成交上）。
 */
export function 对齐阶段与状态(
  改: { stage: string; status: string },
  原: { stage: string; status: string } | null,
): { stage: string; status: string } {
  const 赢 = "赢单成交";
  const 前一档 = OPP_STAGES[OPP_STAGES.indexOf(赢) - 1] ?? OPP_STAGES[0];
  const 动了状态 = !原 || 改.status !== 原.status;
  const 动了阶段 = !原 || 改.stage !== 原.stage;
  // 只动了状态：听状态的
  if (动了状态 && !动了阶段) {
    if (改.status === "WON") return { stage: 赢, status: "WON" };
    if (改.stage === 赢) return { stage: 前一档, status: 改.status };
    return 改;
  }
  // 只动了阶段：听阶段的
  if (动了阶段 && !动了状态) {
    if (改.stage === 赢) return { stage: 赢, status: "WON" };
    if (改.status === "WON") return { stage: 改.stage, status: "OPEN" };
    return 改;
  }
  // 都动了（或新建）：赢单成交那一格说了算
  if (改.stage === 赢) return { stage: 赢, status: "WON" };
  if (改.status === "WON") return { stage: 赢, status: "WON" };
  return 改;
}
