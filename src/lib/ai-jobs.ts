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
  /**
   * 给侧栏那条「AI 任务」用的：这条任务叫什么、点了回哪儿。
   * 不给就不在侧栏出现——起草话术那种几秒钟就回来的不值得占一行。
   */
  标签?: 任务标签;
};

/** 侧栏要显示一条任务，就得说清它是什么、点了回哪儿 */
/** 去 = 点这条任务回哪儿。不给就只把面板/任务列表打开，不导航——
    窄模式（右侧面板）下人是在别的页面问的，拽他去首页是把他赶走 */
export type 任务标签 = { 名: string; 去?: string };

type Result<T> = { ok: true; value: T } | { ok: false; error: string; value?: T };

const jobs = new Map<string, JobState<unknown>>();
const listeners = new Set<() => void>();
const notify = () => {
  版本++;
  listeners.forEach((l) => l());
};

export function runJob<T>(key: string, fn: () => Promise<Result<T>>, meta?: string, 标签?: 任务标签): void {
  const cur = jobs.get(key);
  if (cur?.status === "loading") return;
  const 起 = Date.now();
  jobs.set(key, { status: "loading", meta, startedAt: 起, 标签 });
  notify();
  void fn()
    .then((r) => {
      jobs.set(key, r.ok ? { status: "done", value: r.value, meta, startedAt: 起, 标签 } : { status: "error", error: r.error, value: r.value, meta, startedAt: 起, 标签 });
    })
    .catch((e: unknown) => {
      jobs.set(key, { status: "error", error: e instanceof Error ? e.message : "调用失败", meta, startedAt: 起, 标签 });
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

/**
 * 把一条从侧栏的「AI 任务」里收起来，**但任务本身留着**。
 *
 * 2026-09-19 报上来的：点一下任务条，右边那条回答就没了。
 * 因为原来点的是 `clearJob` —— 那是把任务整个删掉，
 * 而面板里那条回答正是从这个任务读出来的（`useJob("home:" + turn.id)`）。
 * 用户想的是「这条我看过了，从列表里划掉」，结果连答案一起划掉了。
 *
 * 侧栏那张单子是按 `标签` 过滤出来的（见 任务快照），所以摘掉标签就够了。
 */
export function 收起任务(key: string): void {
  const cur = jobs.get(key);
  if (!cur?.标签) return;
  // 还在跑的不收：那条正是用来告诉人「它还没完」的。组件也挡了一道，这里是里子
  if (cur.status === "loading") return;
  const { 标签: _丢掉, ...剩下 } = cur;
  void _丢掉;
  jobs.set(key, 剩下 as JobState<unknown>);
  notify();
}

export function getJob<T>(key: string): JobState<T> | undefined {
  return jobs.get(key) as JobState<T> | undefined;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * 带标签的那些任务，给侧栏用。
 *
 * 快照要缓存：useSyncExternalStore 每次都拿新数组会无限重渲。
 * 任务表一变就重算一次，不变就返回上一次那个引用。
 */
let 快照: { key: string; status: JobState<unknown>["status"]; 标签: 任务标签; 有建议: boolean }[] = [];
let 快照版本 = -1;
let 版本 = 0;

export function useAiTasks() {
  return useSyncExternalStore(subscribe, 任务快照, () => 空快照);
}

/**
 * 侧栏要显示的那几条。抽成普通函数是为了能直接测——
 * 这一条的行为（跑着的排前面、答完带建议卡的标成「需确认」、清掉就消失）
 * 是「切走了也不会丢」这件事的全部实现，值得钉住。
 */
export function 任务快照() {
  if (快照版本 === 版本) return 快照;
  快照版本 = 版本;
  快照 = [...jobs.entries()]
    .filter(([, j]) => j.标签)
    .map(([key, j]) => ({
      key,
      status: j.status,
      标签: j.标签!,
      /* 「需确认」= 答完了、但里面有还没点确认的建议卡。
         各种模式的返回结构不一样，这里只认这一个共同的形状 */
      有建议: Boolean((j.value as { answer?: { proposals?: unknown[] } } | undefined)?.answer?.proposals?.length),
    }))
    .sort((a, b) => (a.status === "loading" ? -1 : b.status === "loading" ? 1 : 0));
  return 快照;
}

const 空快照: { key: string; status: JobState<unknown>["status"]; 标签: 任务标签; 有建议: boolean }[] = [];

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
