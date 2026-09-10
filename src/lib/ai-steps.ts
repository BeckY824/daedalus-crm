/**
 * AI 工作流的"过程事件"：让人看见它在干什么，而不是转一个圈等十几秒。
 *
 * 每个 AI 动作在关键节点 emit 一条 step：开始时 running，完成时 done（带一句结果摘要），
 * 出错时 error。走 /api/ai/stream 时这些事件按 SSE 逐条推到浏览器；
 * 作为普通 Server Action 调用时 emit 不传，行为不变。
 */
export type StepStatus = "running" | "done" | "error";

export type StepEvent = {
  type: "step";
  /** 同一动作内唯一，用来把 running 更新成 done */
  id: string;
  /** 给人看的动作名，如「读取记录」 */
  label: string;
  status: StepStatus;
  /** 完成后的一句摘要，如「6 条跟进、2 段原文」 */
  detail?: string;
  /** 模型做这一步前的一句打算（agent 的 thought），展开过程时给人看 */
  thought?: string;
  at: number;
};

export type Emit = (e: Omit<StepEvent, "type" | "at">) => void;

/** 便捷：开始一步 */
export function stepStart(emit: Emit | undefined, id: string, label: string) {
  emit?.({ id, label, status: "running" });
}

/** 便捷：完成一步并附摘要 */
export function stepDone(emit: Emit | undefined, id: string, label: string, detail?: string) {
  emit?.({ id, label, status: "done", detail });
}

/** 把 step 列表按 id 合并：后到的覆盖先到的，顺序按首次出现 */
export function mergeSteps(list: StepEvent[], e: StepEvent): StepEvent[] {
  const i = list.findIndex((s) => s.id === e.id);
  if (i === -1) return [...list, e];
  const next = list.slice();
  next[i] = e;
  return next;
}
