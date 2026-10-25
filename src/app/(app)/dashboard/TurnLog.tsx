"use client";
import { memo } from "react";
import { clearJob } from "@/lib/ai-jobs";
import { cancelStream } from "@/lib/ai-stream";
import { dequeueTurn, removeTurn, updateTurn, type Turn } from "@/lib/home-thread";
import TurnView from "./TurnView";

/**
 * 这一屏要对一轮做的事。HomeChat 给的是**一个不变的对象**，里面每次去取最新的那份——
 * 这样输入框打字、父组件重渲时，这里的 props 一样都没变，整列对话不跟着重渲。
 */
export type 一轮的动作 = {
  start: (t: Turn) => void;
  在跑: () => boolean;
  /** 走输入框那条完整的发送路（命令、背调意图、排队都认） */
  问: (q: string) => void;
};

/** 已经问过的那一列。只在换了几轮、或刚发了一问时重渲；流式出字只重渲正在流的那一轮（ai-jobs 按键订阅） */
function TurnLog({ turns, 刚发的, scope, 动作 }: { turns: Turn[]; 刚发的: string | null; scope: string; 动作: 一轮的动作 }) {
  return (
    <div className="cli-log">
      {turns.map((t) => (
        <TurnView
          key={t.id}
          turn={t}
          scrollOnMount={t.id === 刚发的}
          onRetry={() => {
            clearJob(`home:${t.id}`);
            // 找公司后接着背调的那一轮：重新背调是新的一次（新 runId，照常扣），不再沿用找公司那一笔
            if (t.接着) updateTurn(scope, t.id, { 接着: undefined });
            if (动作.在跑()) dequeueTurn(scope, t.id);
            动作.start(t);
          }}
          onRemove={() => {
            cancelStream(`home:${t.id}`);
            clearJob(`home:${t.id}`);
            removeTurn(scope, t.id);
          }}
          onAsk={(q) => 动作.问(q)}
          on选定={(公司) => updateTurn(scope, t.id, { 公司, 待选: undefined })}
          on改={(patch) => updateTurn(scope, t.id, patch)}
        />
      ))}
      <div />
    </div>
  );
}

export default memo(TurnLog);
