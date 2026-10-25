/**
 * 当前是谁：requireUser 的 mock 先看这里（AsyncLocalStorage），所以「两人同时领」这种并发的调用各算各的人。
 * 测试文件和 vi.mock 的工厂都从这个文件拿，同一个实例。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type 会话人 = { id: string; name: string; email: string; role: string; title: string; avatar: null };

export const 当前人 = new AsyncLocalStorage<会话人>();
