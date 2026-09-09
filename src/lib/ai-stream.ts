"use client";

/**
 * 浏览器这一侧消费 /api/ai/stream：把 SSE 事件逐条写进 ai-jobs 的任务里。
 * 组件只订阅任务，不碰网络；切页不会中断读取，因为读取跑在模块级的 runJob 里。
 */
import { runJob, patchJob } from "./ai-jobs";
import { mergeSteps, type StepEvent } from "./ai-steps";

export type StreamBody =
  | { mode: "home"; question: string }
  | { mode: "quick"; intent: "prep" | "recap" }
  | { mode: "brief"; customerId: string; question?: string };

export type StreamJob<T> = { steps: StepEvent[]; answer?: T; ms?: number };

export function runStream<T>(key: string, body: StreamBody, meta?: string): void {
  runJob<StreamJob<T>>(
    key,
    async () => {
      const t0 = Date.now();
      let steps: StepEvent[] = [];
      patchJob<StreamJob<T>>(key, { steps });
      let res: Response;
      try {
        res = await fetch("/api/ai/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } catch {
        return { ok: false, error: "网络错误，请稍后重试" };
      }
      if (!res.ok || !res.body) return { ok: false, error: `请求失败（${res.status}）` };

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let final: { ok: true; value: StreamJob<T> } | { ok: false; error: string; value?: StreamJob<T> } | null = null;
      let finished = false;
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) {
          // 最后一个事件后面可能没有空行，补一个把它冲出来
          buf += decoder.decode() + "\n\n";
          finished = true;
        } else {
          buf += decoder.decode(value, { stream: true });
        }
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let ev: unknown;
          try {
            ev = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          const e = ev as { type: string } & Record<string, unknown>;
          if (e.type === "step") {
            steps = mergeSteps(steps, e as unknown as StepEvent);
            patchJob<StreamJob<T>>(key, { steps });
          } else if (e.type === "result") {
            const r = e as unknown as { ok: boolean; answer?: T; error?: string };
            // 出错也把走过的步骤留着：人能看到卡在哪一步
            final = r.ok ? { ok: true, value: { steps, answer: r.answer, ms: Date.now() - t0 } } : { ok: false, error: r.error ?? "生成失败", value: { steps, ms: Date.now() - t0 } };
          }
        }
      }
      return final ?? { ok: false, error: "连接中断，请重试", value: { steps } };
    },
    meta,
  );
}
