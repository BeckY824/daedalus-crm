"use client";

/**
 * AI 调用的进程内任务表。
 *
 * 组件里的 useState 一离开页面就没了：点了「起草邀请」切去别处再回来，
 * 转圈和结果都不见，而模型那边其实还在跑、跑完了也没人接。
 * 这里把每个 AI 任务按 key 放在模块级的 Map 里：组件卸载不影响任务，
 * 回来时按 key 取回"正在转 / 已完成 / 出错"的状态和结果。
 *
 * 同一个 key 正在跑时再次触发会直接忽略（去重），避免连点打两次模型。
 * 只活在这个页面进程里；整页刷新后清空，和"AI 只起草不落库"一致。
 */
import { useSyncExternalStore } from "react";

export type JobState<T> = {
  status: "loading" | "done" | "error";
  value?: T;
  error?: string;
  /** 调用方自带的小标记，比如首页提问框记"哪个按钮在转" */
  meta?: string;
  startedAt: number;
};

type Result<T> = { ok: true; value: T } | { ok: false; error: string; value?: T };

const jobs = new Map<string, JobState<unknown>>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function runJob<T>(key: string, fn: () => Promise<Result<T>>, meta?: string): void {
  const cur = jobs.get(key);
  if (cur?.status === "loading") return;
  jobs.set(key, { status: "loading", meta, startedAt: Date.now() });
  notify();
  void fn()
    .then((r) => {
      jobs.set(key, r.ok ? { status: "done", value: r.value, meta, startedAt: Date.now() } : { status: "error", error: r.error, value: r.value, meta, startedAt: Date.now() });
    })
    .catch((e: unknown) => {
      jobs.set(key, { status: "error", error: e instanceof Error ? e.message : "调用失败", meta, startedAt: Date.now() });
    })
    .finally(notify);
}

/** 任务还在跑时更新它的中间结果（比如流式过来的步骤），状态保持 loading */
export function patchJob<T>(key: string, value: T): void {
  const cur = jobs.get(key);
  if (!cur || cur.status !== "loading") return;
  jobs.set(key, { ...cur, value });
  notify();
}

/** 直接放一个已完成的结果（比如从 sessionStorage 恢复的简报） */
export function setJobValue<T>(key: string, value: T): void {
  jobs.set(key, { status: "done", value, startedAt: Date.now() });
  notify();
}

export function clearJob(key: string): void {
  if (jobs.delete(key)) notify();
}

export function getJob<T>(key: string): JobState<T> | undefined {
  return jobs.get(key) as JobState<T> | undefined;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** 订阅一个任务的状态；key 为 null 时不订阅。服务端渲染一律 undefined */
export function useJob<T>(key: string | null): JobState<T> | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (key ? (jobs.get(key) as JobState<T> | undefined) : undefined),
    () => undefined,
  );
}

/** 一组 key 里第一个正在跑的；没有就 null。快照是字符串，稳定不抖 */
export function useRunningKey(keys: string[]): string | null {
  const joined = keys.join("\u0000");
  return useSyncExternalStore(
    subscribe,
    () => joined.split("\u0000").find((k) => k && jobs.get(k)?.status === "loading") ?? null,
    () => null,
  );
}
