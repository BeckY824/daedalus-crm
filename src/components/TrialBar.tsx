"use client";

import Link from "next/link";

/**
 * 试用状态横条。只有托管版会渲染。
 *
 * 出现的时机克制：还剩 3 天以上时什么都不显示——每天顶着一条广告会让人
 * 觉得这是个催费的产品。进入最后三天才提示，到期后变成拦截说明。
 */
export default function TrialBar({ daysLeft, writable }: { daysLeft: number; writable: boolean }) {
  if (writable && daysLeft > 3) return null;

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

  return (
    <div className="trialbar">
      <span>试用还剩 {daysLeft} 天。</span>
      <Link href="/billing" className="trialbar-cta">
        开通订阅
      </Link>
    </div>
  );
}
