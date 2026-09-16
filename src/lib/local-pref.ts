"use client";

/**
 * 存在这台机器上的小偏好（现在只有「列表页显示哪几列」）。
 *
 * 为什么不是 useState + useEffect 读一遍：那样等于在 effect 里 setState，
 * 会多渲染一轮，服务端渲染出来的还是默认那套、水合之后再跳一下。
 * useSyncExternalStore 天生分服务端快照和客户端快照，水合时用前者，之后用后者，
 * 既不会警告不一致，也不会闪一下。
 *
 * 读不到、存不下、存进去的是坏 JSON——都当没存过，回到默认值。
 * 这里放的东西必须是「丢了也不影响用」的：真正要留住的状态不该在浏览器本地。
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
/** 按 key 缓存上一次解析的结果：getSnapshot 每次都要返回同一个引用，否则会无限重渲 */
const cache = new Map<string, { raw: string | null; value: unknown }>();
/** 存不进去时（隐私模式、配额满）退到内存里，至少这一次点的还算数 */
const memory = new Map<string, unknown>();

function read<T>(key: string, fallback: T): T {
  if (memory.has(key)) return memory.get(key) as T;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    /* 隐私模式下会抛，当没存过 */
  }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value as T;
  let value = fallback;
  if (raw) {
    try {
      value = JSON.parse(raw) as T;
    } catch {
      value = fallback;
    }
  }
  cache.set(key, { raw, value });
  return value;
}

export function useLocalPref<T>(key: string, fallback: T): [T, (v: T) => void] {
  const subscribe = useCallback((l: () => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  const 值 = useSyncExternalStore(
    subscribe,
    () => read(key, fallback),
    () => fallback,
  );
  const 写 = useCallback(
    (v: T) => {
      try {
        localStorage.setItem(key, JSON.stringify(v));
        memory.delete(key);
      } catch {
        // 存不进去就退到内存：这次会话里还算数，换个标签页就没了
        memory.set(key, v);
      }
      cache.delete(key);
      listeners.forEach((l) => l());
    },
    [key],
  );
  return useMemo<[T, (v: T) => void]>(() => [值, 写], [值, 写]);
}
