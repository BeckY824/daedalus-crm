"use client";

import Link from "next/link";
import { LoadingOutlined, CheckCircleOutlined, ExclamationCircleOutlined } from "@ant-design/icons";
import { clearJob, useAiTasks } from "@/lib/ai-jobs";

/**
 * 侧栏底部的「AI 任务」。
 *
 * 问题出在这儿：问一句要十几秒，人不会盯着看——他会切去别的页面。
 * 原来切走之后就没有任何迹象说明还有东西在跑，回来才发现早答完了；
 * 或者压根忘了自己问过。Codex 的做法是每个线程一个可见的状态，照搬。
 *
 * 任务本身活在进程内的任务表里（lib/ai-jobs），组件卸载不影响它，
 * 所以这里只是把有标签的那几条列出来：跑着的、答完的、答完但里面有建议卡
 * 还等着人点确认的。点一条回到它原来那个位置。
 *
 * 只列带标签的：起草话术那种几秒钟就回来的不占一行。
 */
export default function AiTasks() {
  const 任务 = useAiTasks();
  if (任务.length === 0) return null;

  return (
    <div className="aitasks">
      <div className="aitasks-t">AI 任务</div>
      {任务.slice(0, 4).map((t) => (
        <Link
          key={t.key}
          href={t.标签.去}
          className={`aitask aitask-${t.status}`}
          // 答完的点开就算看过了，从列表里去掉；还在跑的点开只是过去看看，留着
          onClick={() => t.status !== "loading" && clearJob(t.key)}
        >
          <span className="aitask-i">
            {t.status === "loading" ? <LoadingOutlined /> : t.status === "error" ? <ExclamationCircleOutlined /> : <CheckCircleOutlined />}
          </span>
          <span className="aitask-n">{t.标签.名}</span>
          <span className="aitask-s">
            {t.status === "loading" ? "进行中" : t.status === "error" ? "失败" : t.有建议 ? "需确认" : "已答完"}
          </span>
        </Link>
      ))}
    </div>
  );
}
