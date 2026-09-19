"use client";

/**
 * 对话线程：一串「问题 → 回答任务 key」。
 * 放在模块级而不是组件 state：切去别的页面再回来，对话还在，正在转的还在转。
 * 回答本身存在 ai-jobs 里（key = home:<id>），这里只记顺序。
 *
 * 2026-09-18 之前整页刷新就全没了。现在答完的每一轮会落库
 * （app/(app)/dashboard/threads.ts），刷新或换台机器都还在；
 * 这里仍然只管**内存里这一屏**：哪条对话、有哪几轮、正在跑的是哪一轮。
 * 库 → 内存由页面在挂载时调 `载入对话()` 完成。
 *
 * ---
 *
 * **按「屏」分开存，不是一份全局。** 2026-09-19 报上来的：在线索页问一句，
 * 换到客户页、回到首页，那一问那一答跟着到处走——因为这里原来就是一份
 * `let turns`，而全局 AI 面板在**每一页**都渲染同一个 HomeChat，读的是同一份。
 * 更糟的是 `对话id` 也是全局的：线索页问完再去客户页问，两问会落进库里**同一条对话**。
 *
 * 现在每个 scope 一份独立的 { turns, 对话id }：
 *   "home"     首页那一整屏
 *   "/leads"   线索页面板里的那一屏，以此类推（scope 就是 pathname）
 * 各问各的、各落各的库。落库仍然走同一张 AiConversation 表，所以
 * **首页那条列表照样看得到每一页问过什么**（这是要的：独立的是上下文，不是存档）。
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

/** 首页那一屏的 scope。别的页面用自己的 pathname */
export const 首页屏 = "home";

type 屏 = {
  turns: Turn[];
  /** 这一屏是哪条对话。null = 还没落过库的新对话（问第一句时才会建出来） */
  对话id: string | null;
};

const 屏们 = new Map<string, 屏>();
const EMPTY: Turn[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/**
 * 取一屏，没有就开一份。
 * **只有写操作能调它**——读路径（getSnapshot）里新建对象会每次返回一个新数组，
 * useSyncExternalStore 立刻判定「变了」，渲染就停不下来了。读走 EMPTY。
 */
function 取(scope: string): 屏 {
  let s = 屏们.get(scope);
  if (!s) {
    s = { turns: [], 对话id: null };
    屏们.set(scope, s);
  }
  return s;
}

/**
 * 把库里读回来的一条对话装进这一屏。
 *
 * 幂等：同一条对话重复调不重置——从别的页面切回首页会重新渲染一次，
 * 那时候不能把正在流的那一轮冲掉。换了一条对话（或者新建）才真的换内容。
 */
export function 载入对话(scope: string, id: string | null, 历史: Turn[]): boolean {
  const s = 取(scope);
  if (id !== null && id === s.对话id) return false;
  s.对话id = id;
  s.turns = 历史;
  notify();
  return true;
}

/** 第一问落库之后回填：这一屏从此属于那条对话 */
export function 认领对话(scope: string, id: string) {
  const s = 取(scope);
  if (s.对话id === id) return;
  s.对话id = id;
  notify();
}

export function 当前对话(scope: string): string | null {
  return 屏们.get(scope)?.对话id ?? null;
}

export function useConversationId(scope: string): string | null {
  return useSyncExternalStore(subscribe, () => 屏们.get(scope)?.对话id ?? null, () => null);
}

export function addTurn(scope: string, t: Omit<Turn, "id" | "at">): Turn {
  const s = 取(scope);
  const turn: Turn = { ...t, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now() };
  s.turns = [...s.turns, turn];
  notify();
  return turn;
}

/** 排队的那条轮到它了：去掉排队标记（真正开跑由页面调 runStream） */
export function dequeueTurn(scope: string, id: string) {
  const s = 取(scope);
  s.turns = s.turns.map((t) => (t.id === id ? { ...t, queued: false } : t));
  notify();
}

export function removeTurn(scope: string, id: string) {
  const s = 取(scope);
  s.turns = s.turns.filter((t) => t.id !== id);
  notify();
}

/** 清屏。`/clear` 命令用它——只清这一屏，不动库里那条对话 */
export function clearThread(scope: string) {
  取(scope).turns = [];
  notify();
}

/** 新建对话：这一屏空掉，且不再属于任何一条已落库的对话 */
export function 新起一屏(scope: string) {
  const s = 取(scope);
  s.turns = [];
  s.对话id = null;
  notify();
}

/** 只给测试用：把所有屏抹掉，用例之间不互相串 */
export function 清空所有屏() {
  屏们.clear();
  notify();
}

/**
 * 这一屏现在有哪几轮。**读路径不建屏**：没问过的屏返回同一个 EMPTY，
 * 否则 useSyncExternalStore 每次拿到新数组，渲染就停不下来了。
 */
export function 读屏(scope: string): Turn[] {
  return 屏们.get(scope)?.turns ?? EMPTY;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useThread(scope: string): Turn[] {
  return useSyncExternalStore(subscribe, () => 读屏(scope), () => EMPTY);
}
