"use client";

/**
 * 浏览器这一侧消费 /api/ai/stream：把 SSE 事件逐条写进 ai-jobs 的任务里。
 * 组件只订阅任务，不碰网络；切页不会中断读取，因为读取跑在模块级的 runJob 里。
 */
import { runJob, patchJob, type 任务标签 } from "./ai-jobs";
import { mergeSteps, type StepEvent } from "./ai-steps";
import { 初始状态, 归约, type 背调状态 } from "./research/state";
import type { 研究事件 } from "./research/types";

export type StreamBody =
  | {
      mode: "agent";
      question: string;
      model?: string;
      /** 之前几轮的问答，让模型接得住指代 */
      history?: { q: string; a: string }[];
      /**
       * 当前页是什么（lib/ai-context-page.ts 生成）。
       * **不拼进 question**：意图直连的正则跑在 question 上，拼进去会误命中，
       * 而且存进对话历史的问题会变成一坨。所以走单独的字段，服务端单独喂给模型。
       */
      pageContext?: string;
      /** 同一份上下文的结构化那半（这一页哪张表、列着谁），服务端意图直连用。见 lib/ai-context-page.ts 的 页面范围 */
      pageScope?: { 表: string; 工具: string; 参数: string; 名字: string[] };
      /**
       * 这一问带的文件：浏览器里读成的文本，只随这一问发一次，服务端不落库。
       * 见 components/AskFiles.tsx 和 api/ai/stream 里的收法。
       */
      files?: { name: string; text: string }[];
    }
  | { mode: "brief"; customerId: string; question?: string }
  /** 背调（lib/research）：公司名必填；从客户详情页发起的带客户 id */
  | { mode: "research"; company: string; customerId?: string; /** 背调模式里那句原话，带给模型（让它知道人关心什么） */ need?: string; mail?: unknown; /** 找公司后接着背调：找公司那一次的编号和点选的那家（lib/research/stream.ts 收接着） */ runId?: string; pick?: unknown }
  /** 只有人名 + 电话、没有公司：先找公司（lib/research/person.ts） */
  | { mode: "research"; person: { name?: string; phone: string }; need?: string };

export type StreamJob<T> = {
  steps: StepEvent[];
  answer?: T;
  ms?: number;
  /** 流式回答的已到达文本 */
  text?: string;
  /** 背调：事件一条条叠成的状态（lib/research/state.ts）。只有 mode=research 才有 */
  research?: 背调状态;
};

const controllers = new Map<string, AbortController>();

/** 用户按 Esc：中断请求，任务标成出错并保留已走的步骤 */
export function cancelStream(key: string) {
  controllers.get(key)?.abort();
}

export function runStream<T>(key: string, body: StreamBody, meta?: string, 标签?: 任务标签): void {
  runJob<StreamJob<T>>(
    key,
    async () => {
      const t0 = Date.now();
      let steps: StepEvent[] = [];
      let text = "";
      let research: 背调状态 | undefined =
        body.mode !== "research" ? undefined : "person" in body ? 初始状态({ name: body.person.name || body.person.phone }) : 初始状态({ name: body.company, customerId: body.customerId });
      patchJob<StreamJob<T>>(key, { steps });
      const ac = new AbortController();
      controllers.set(key, ac);
      let res: Response;
      try {
        res = await fetch("/api/ai/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ac.signal });
      } catch (e) {
        controllers.delete(key);
        return { ok: false, error: e instanceof Error && e.name === "AbortError" ? "已取消" : "网络错误，请稍后重试", value: { steps } };
      }
      if (!res.ok || !res.body) return { ok: false, error: `请求失败（${res.status}）` };

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let final: { ok: true; value: StreamJob<T> } | { ok: false; error: string; value?: StreamJob<T> } | null = null;
      let finished = false;
      while (!finished) {
        let chunkRead: ReadableStreamReadResult<Uint8Array>;
        try {
          chunkRead = await reader.read();
        } catch {
          controllers.delete(key);
          return { ok: false, error: "已取消", value: { steps, text, research } };
        }
        const { value, done } = chunkRead;
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
          if (e.type === "research" && research && e.e && typeof e.e === "object") {
            // 背调的过程事件：叠进状态，界面订阅的是这份状态（一条条展开就靠它）
            research = 归约(research, e.e as 研究事件);
            patchJob<StreamJob<T>>(key, { steps, text, research });
          } else if (e.type === "step") {
            steps = mergeSteps(steps, e as unknown as StepEvent);
            patchJob<StreamJob<T>>(key, { steps, text, research });
          } else if (e.type === "token" && typeof e.text === "string") {
            text += e.text;
            patchJob<StreamJob<T>>(key, { steps, text });
          } else if (e.type === "reset") {
            /*
              **把已经推出去的正文抹掉，重新开始。**

              服务端发现刚才那一段根本不是答案（工具调用的协议标记、光秃秃一个工具名、
              只承诺不执行——三种都是 bakeoff 真跑出来的）时会发它，紧接着重答一遍。

              没有它的话，重答只能靠「先攒完再验再推」，那等于所有回答都不流式了。
              有了它，常见的好情况照样逐字蹦，坏情况一闪而过再被替换掉。
              客户端和本地服务是同一个包发的，不存在只认 token 不认 reset 的旧客户端。
            */
            text = "";
            patchJob<StreamJob<T>>(key, { steps, text });
          } else if (e.type === "result") {
            const r = e as unknown as { ok: boolean; answer?: T; error?: string };
            // 出错也把走过的步骤留着：人能看到卡在哪一步
            final = r.ok ? { ok: true, value: { steps, answer: r.answer, text, ms: Date.now() - t0, research } } : { ok: false, error: r.error ?? "生成失败", value: { steps, text, ms: Date.now() - t0, research } };
          }
        }
      }
      controllers.delete(key);
      return final ?? { ok: false, error: "连接中断，请重试", value: { steps, text, research } };
    },
    meta,
    标签,
  );
}
