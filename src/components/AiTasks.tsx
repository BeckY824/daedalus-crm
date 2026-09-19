"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { CheckCircleOutlined, ExclamationCircleOutlined } from "@ant-design/icons";
import { 收起任务, useAiTasks } from "@/lib/ai-jobs";
import { 挑一条, 类名 as 态类名, 该自动消, 通知文案, 自动消毫秒 } from "@/lib/ai-task-bar";

declare global {
  interface Window {
    /** 桌面端的壳给的（desktop/preload-app.js）。网页版没有这个口子 */
    desktopNotify?: { 通知: (标题: string, 正文: string) => void };
  }
}

/**
 * 侧栏底部的「AI 任务」——**一条完成通知，不是一张常驻的单子**。
 *
 * 要解决的还是那件事：问一句要十几秒，人不会盯着看，他会切去别的页面，
 * 回来才发现早答完了。但 2026-09-19 那一版做成了左下角一个方块列表，
 * 最多四行、答完了还得人点一下才消失——于是它一直占着地方，
 * 而人想知道的只有「我刚问那句，答完了没有」。
 *
 * 现在分两层（照 codex / Claude Code）：
 *   人还在这个窗口里 → 侧栏这一条：跑着时一条细进度，答完变一行字，3 秒后自己淡出
 *   人切去别的应用了 → 桌面端发一条系统通知（壳判断在不在前台，见 desktop/main.js）
 *
 * 挑哪一条、谁会自己走、叫人时说什么，都在 lib/ai-task-bar.ts 里，那边有用例钉着。
 * 任务本身活在模块级的任务表（lib/ai-jobs），组件卸载不影响它。
 */
export default function AiTasks() {
  const 任务 = useAiTasks();
  const 条 = 挑一条(任务);

  /*
    答完的自己走。计时表用 ref 按 key 记：任务表一有风吹草动这个 effect 就会重跑
    （别的那条还在流，每来一段字就是一次通知），按 key 占位才不会把已经在倒计时的
    那一条一次次重置——那样它就永远走不掉了。
  */
  const 计时 = useRef(new Map<string, number>());
  useEffect(() => {
    const 表 = 计时.current;
    for (const t of 任务) {
      if (!该自动消(t) || 表.has(t.key)) continue;
      表.set(
        t.key,
        window.setTimeout(() => {
          表.delete(t.key);
          收起任务(t.key);
        }, 自动消毫秒),
      );
    }
    // 已经不在单子上的（收起了、清掉了）把计时也撤掉
    const 还在 = new Set(任务.map((t) => t.key));
    for (const [k, id] of 表) {
      if (!还在.has(k)) {
        clearTimeout(id);
        表.delete(k);
      }
    }
  }, [任务]);
  useEffect(() => {
    const 表 = 计时.current;
    return () => {
      for (const id of 表.values()) clearTimeout(id);
      表.clear();
    };
  }, []);

  /*
    跑完了叫人一声。一条任务只叫一次——effect 会重跑很多遍，不占位就会连着弹。
    弹不弹由壳决定：窗口在前台就不弹（侧栏这一条已经说了），网页版根本没有这个口子。
  */
  const 已叫过 = useRef(new Set<string>());
  useEffect(() => {
    for (const t of 任务) {
      if (t.status === "loading" || 已叫过.current.has(t.key)) continue;
      已叫过.current.add(t.key);
      const 文 = 通知文案(t);
      if (文) window.desktopNotify?.通知(文.标题, 文.正文);
    }
  }, [任务]);

  if (!条) return null;

  const 里面 = (
    <>
      <span className="aitask-l">
        {条.态 !== "跑着" && (
          <span className="aitask-i">{条.态 === "失败" ? <ExclamationCircleOutlined /> : <CheckCircleOutlined />}</span>
        )}
        <span className="aitask-n">{条.名}</span>
        {条.还有 > 0 && <span className="aitask-m">+{条.还有}</span>}
        <span className="aitask-s">{条.说明}</span>
      </span>
      {/* 说不出百分比就别装：一段来回扫的刻度，和更新药丸那条 idle 是同一个说法 */}
      {条.态 === "跑着" && <span className="aitask-bar" aria-hidden />}
    </>
  );

  const 类 = `aitask aitask-${态类名[条.态]}`;
  /*
    还在跑的点了只是过去看看，不收起——那条正是用来告诉人「它还没完」的。
    没有「去」的（右侧面板里问的那些）不画成链接：人就在他要待的那一页上，
    画成 <a href=undefined> 点了会跳到当前页、白重载一次，把他刚问的上下文冲掉。
  */
  const 点 = () => 条.态 !== "跑着" && 收起任务(条.key);
  return (
    <div className="aitasks">
      {条.去 ? (
        <Link href={条.去} className={类} onClick={点}>
          {里面}
        </Link>
      ) : (
        <button type="button" className={类} onClick={点}>
          {里面}
        </button>
      )}
    </div>
  );
}
