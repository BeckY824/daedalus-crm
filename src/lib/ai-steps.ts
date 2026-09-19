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

/**
 * 库里读回来的那段轨迹，认成 StepEvent[]。
 *
 * **形状对不上的整条丢掉，而不是照单放行。** `AiMessage.steps` 存的是一段自由 JSON，
 * 写它的是当时那一版代码；读它的 summarizeSteps 上来就 `s.id.startsWith(...)`，
 * 少一个 id 就是一个运行时 TypeError——而它在 HomeChat 的渲染路径上，
 * 炸的是**整页白屏**，首页和面板一起。
 *
 * 这和 threads.ts 里 解析() 那句是同一个道理，只是那一层只挡住了「JSON 都解不出来」：
 * 「解得出来但不是这个形状」原来一路放进了渲染。翻历史时少一行轨迹，
 * 总好过整页打不开——那一行本来也只是「读了什么」的摘要，回答正文不受影响。
 */
export function 认步骤(v: unknown): StepEvent[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (s): s is StepEvent =>
      !!s && typeof s === "object" && typeof (s as StepEvent).id === "string" && typeof (s as StepEvent).label === "string",
  );
}
