"use client";

/**
 * 首页对话的线程：一串「问题 → 回答任务 key」。
 * 放在模块级而不是组件 state：切去别的页面再回来，对话还在，正在转的还在转。
 * 回答本身存在 ai-jobs 里（key = home:<id>），这里只记顺序。整页刷新后清空。
 */
import { useSyncExternalStore } from "react";

export type Turn = { id: string; question: string; kind: "ask" | "prep" | "recap"; at: number; /** 上一问还在跑时发的：排队，等它答完再起 */ queued?: boolean };

let turns: Turn[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

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

export function clearThread() {
  turns = [];
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
