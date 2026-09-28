"use client";

import { useEffect, useState } from "react";

/**
 * 等 AI 的那几秒到几十秒，界面上说什么。
 *
 * 首页和记录页的简报有一条逐步的过程条（AiTrace），因为 agent 真的是一步一步走的。
 * 这里给的是另一类调用——**一次请求、中间没有步骤可报**的（跟进速记解析、粘贴整理成表格）。
 * 原来这些地方只有按钮上一个圈，人不知道它在干什么、还要多久、是不是卡住了。
 *
 * 说不出百分比就不装（和侧栏任务条、更新药丸一个说法）。能诚实说的只有三样：
 *   1. **它在做什么**——一句具体的话，不是「处理中」
 *   2. **过了几秒**——等宽数字，一秒一跳，不抖
 *   3. **慢了就说慢了**——过了 15 秒补一行，告诉人可以先去做别的，好了会叫他
 * 做完变成一行结果摘要（人一眼知道 AI 认出了什么），出错变成一行红字。
 *
 * 样子照首页那条过程条：同一个呼吸点、同一种字号。跑着的那句话上走一道光——
 * 扫一遍、停一下、再扫，而不是一直匀速转（那是加载，不是在想）。
 * 开了「减弱动态」：光不走、点不呼吸，只剩字和秒数。
 *
 * **全站等 AI 只有这一种样子**（2026-09-28 统一）：原来首页对话是「在想...」三个点轮流闪，
 * 记录页还留着一套上下跳的三点（位移循环，减弱动态下也该停的那种），同一件事三种长相。
 * 首页对话的「在想 / 在写」现在也是这个组件，它要多写一句「Esc 打断」，走 附注。
 */
export default function AiWait({
  在做,
  起,
  结果,
  出错,
  慢于秒 = 15,
  附注,
  className,
}: {
  /** 跑着时的那句话。要具体：「从这段话里认出跟进方式、结果和下次时间」，不是「AI 处理中」 */
  在做: string;
  /** 开始的时刻（Date.now()）。放在任务表里的任务直接传它的 startedAt，切走再回来秒数接得上 */
  起: number;
  /** 做完了的一行摘要。给了就是做完 */
  结果?: string | null;
  出错?: string | null;
  慢于秒?: number;
  /** 跑着时跟在秒数后面的一句，比如「Esc 打断」 */
  附注?: string;
  className?: string;
}) {
  const 跑着 = !结果 && !出错;
  const [现在, set现在] = useState(() => Date.now());
  useEffect(() => {
    if (!跑着) return;
    const id = window.setInterval(() => set现在(Date.now()), 1000);
    return () => clearInterval(id);
  }, [跑着]);
  const 秒 = Math.max(0, Math.floor((现在 - 起) / 1000));
  const 慢 = 跑着 && 秒 >= 慢于秒;

  return (
    <div className={`aiw${className ? ` ${className}` : ""}`} role="status" aria-live="polite">
      <div className="aiw-row">
        <span className={`aiw-dot ${出错 ? "aiw-dot-err" : 结果 ? "aiw-dot-done" : "aiw-dot-run"}`} aria-hidden />
        {/* key 跟着状态换：从「在做」换成「结果」时整句淡进来，不是原地改字 */}
        <span key={出错 ? "err" : 结果 ? "done" : "run"} className={`aiw-text${跑着 ? " aiw-shine" : ""}${出错 ? " aiw-text-err" : ""}`}>
          {出错 ?? 结果 ?? 在做}
        </span>
        {跑着 && (
          <span className="aiw-sec">
            {秒}s{附注 ? ` · ${附注}` : ""}
          </span>
        )}
      </div>
      {慢 && <div className="aiw-slow">比平时慢一些，模型那边可能在排队。可以先去做别的，好了会提醒你。</div>}
    </div>
  );
}
