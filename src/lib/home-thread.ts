"use client";

/**
 * 首页对话的线程：一串「问题 → 回答任务 key」。
 * 放在模块级而不是组件 state：切去别的页面再回来，对话还在，正在转的还在转。
 * 回答本身存在 ai-jobs 里（key = home:<id>），这里只记顺序。
 *
 * 2026-09-18 之前整页刷新就全没了。现在答完的每一轮会落库
 * （app/(app)/dashboard/threads.ts），刷新或换台机器都还在；
 * 这里仍然只管**内存里这一屏**：哪条对话、有哪几轮、正在跑的是哪一轮。
 * 库 → 内存由页面在挂载时调 `载入对话()` 完成。
 */
import { useSyncExternalStore } from "react";

export type Turn = {
  id: string;
  question: string;
  kind: "ask" | "prep" | "recap";
  at: number;
  /** 上一问还在跑时发的：排队，等它答完再起 */
  queued?: boolean;
  /**
   * 这一问带的文件（在浏览器里读成的文本）。**只在内存里**，也不落库——
   * 问答本身 2026-09-18 起会存进 AiMessage，但附件原文不存：
   * 一旦入库，人粘进去的聊天记录就进了备份。见 components/AskFiles.tsx。
   */
  files?: { name: string; text: string }[];
};

let turns: Turn[] = [];
/** 这一屏是哪条对话。null = 还没落过库的新对话（问第一句时才会建出来） */
let 对话id: string | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/**
 * 把库里读回来的一条对话装进这一屏。
 *
 * 幂等：同一条对话重复调不重置——从别的页面切回首页会重新渲染一次，
 * 那时候不能把正在流的那一轮冲掉。换了一条对话（或者新建）才真的换内容。
 */
export function 载入对话(id: string | null, 历史: Turn[]): boolean {
  if (id !== null && id === 对话id) return false;
  对话id = id;
  turns = 历史;
  notify();
  return true;
}

/** 第一问落库之后回填：这一屏从此属于那条对话 */
export function 认领对话(id: string) {
  if (对话id === id) return;
  对话id = id;
  notify();
}

export function 当前对话(): string | null {
  return 对话id;
}

export function useConversationId(): string | null {
  return useSyncExternalStore(subscribe, () => 对话id, () => null);
}

export function addTurn(t: Omit<Turn, "id" | "at">): Turn {
  const turn: Turn = { ...t, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now() };
  turns = [...turns, turn];
  notify();
  return turn;
}

/** 排队的那条轮到它了：去掉排队标记（真正开跑由页面调 runStream） */
export function dequeueTurn(id: string) {
  turns = turns.map((t) => (t.id === id ? { ...t, queued: false } : t));
  notify();
}

export function removeTurn(id: string) {
  turns = turns.filter((t) => t.id !== id);
  notify();
}

/** 清屏。`/clear` 命令用它——只清这一屏，不动库里那条对话 */
export function clearThread() {
  turns = [];
  notify();
}

/** 新建对话：这一屏空掉，且不再属于任何一条已落库的对话 */
export function 新起一屏() {
  turns = [];
  对话id = null;
  notify();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const EMPTY: Turn[] = [];

export function useThread(): Turn[] {
  return useSyncExternalStore(subscribe, () => turns, () => EMPTY);
}
