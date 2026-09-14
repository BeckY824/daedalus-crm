"use client";

import Link from "next/link";

/**
 * 试用状态横条。只有托管版会渲染。
 *
 * 出现的时机克制：还剩 3 天以上时什么都不显示——每天顶着一条广告会让人
 * 觉得这是个催费的产品。进入最后三天才提示，到期后变成拦截说明。
 */
export default function TrialBar({ daysLeft, writable, aiLeft }: { daysLeft: number; writable: boolean; aiLeft?: number | null }) {
  /**
   * AI 免费次数是独立的一条线：可能还剩 25 天试用，但 5 次已经用完。
   * 所以它不能只跟着天数一起显示——用完了必须当场说，
   * 否则人问一句被拒一句，不知道发生了什么。
   */
  const AI用完 = typeof aiLeft === "number" && aiLeft <= 0;
  const AI快用完 = typeof aiLeft === "number" && aiLeft > 0 && aiLeft <= 2;

  if (writable && daysLeft > 3 && !AI用完 && !AI快用完) return null;

  if (!writable) {
    return (
      <div className="trialbar trialbar-over">
        <span>试用已结束。数据还在，可以继续查看和导出；恢复新增与修改需要开通订阅。</span>
        <Link href="/billing" className="trialbar-cta">
          开通订阅
        </Link>
      </div>
    );
  }

  if (AI用完) {
    return (
      <div className="trialbar trialbar-over">
        <span>试用期的 AI 免费次数已用完。其余功能不受影响，照常可用；开通订阅后 AI 不限次数。</span>
        <Link href="/billing" className="trialbar-cta">
          开通订阅
        </Link>
      </div>
    );
  }

  return (
    <div className="trialbar">
      <span>
        {daysLeft <= 3 && `试用还剩 ${daysLeft} 天。`}
        {AI快用完 && `AI 免费次数还剩 ${aiLeft} 次。`}
      </span>
      <Link href="/billing" className="trialbar-cta">
        开通订阅
      </Link>
    </div>
  );
}
