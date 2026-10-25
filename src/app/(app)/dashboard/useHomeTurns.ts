"use client";
import { useEffect, useEffectEvent } from "react";
import { useRouter } from "next/navigation";
import type { 页面范围 } from "@/lib/ai-context-page";
import { getJob, useRunningKey } from "@/lib/ai-jobs";
import { runStream, cancelStream, type StreamJob } from "@/lib/ai-stream";
import { dequeueTurn, useThread, 认领对话, 认落, 当前对话, type Turn } from "@/lib/home-thread";
import { 载入历史, type AgentAnswer, type 历史消息 } from "@/lib/thread-history";
import { useAiOutOfCredits } from "@/components/AiCost";
import { Esc归别人 } from "@/lib/esc";
import { 落一轮 } from "./threads";

/**
 * 这一屏的对话本身：哪几轮、谁在跑、谁在排队、答完落库、Esc 打断。
 *
 * 从 HomeChat 里拆出来（2026-10-24）：原来这些和输入框的状态挤在同一个组件里，
 * 打一个字整屏的对话记录都跟着重渲。现在输入框的状态归 Composer，
 * 这里只在「换了一轮 / 有一轮开跑或停了」时才变。
 */
export function useHomeTurns({ 会话, scope, model, 模式, 上下文提示, 上下文范围, 标题前缀 }: {
  会话: { id: string; title: string; messages: 历史消息[] } | null;
  scope: string;
  model: string;
  模式: "宽" | "窄";
  上下文提示?: string;
  上下文范围?: 页面范围;
  标题前缀?: string;
}) {
  const AI已用完 = useAiOutOfCredits();
  const router = useRouter();
  const turns = useThread(scope);
  const runningKey = useRunningKey(turns.map((t) => `home:${t.id}`));

  /**
   * 库 → 这一屏。
   *
   * 只在「换了一条对话」时真的换内容（见 home-thread 的 载入对话）：
   * 从客户页切回首页也会跑这个 effect，那时候不能把正在流的那一轮冲掉。
   * 地址上没有 ?c= 时什么都不做——新建对话走的是中栏那颗键，不是靠地址栏。
   */
  useEffect(() => {
    if (!会话) return;
    载入历史(scope, 会话);
  }, [会话, scope]);

  /**
   * 答完一轮就落库。
   *
   * 在这儿做而不是在 runStream 里：那边是模块级的，不认识「当前是哪条对话」，
   * 也没有 router。先认领再发请求——这个 effect 会因为任务表变动跑好几次，
   * 不占位的话同一轮会落两遍。
   *
   * 占位用 认落()（模块级，一屏一份），**不是组件里的 ref**：把面板关掉再打开
   * 就是一次重挂载，而 turns 和答案都活在模块级，ref 里那道闸会跟着新实例清零，
   * 于是同一轮又落一遍——库里两条一模一样、连用时都一样的回答就是这么来的。
   */
  useEffect(() => {
    void (async () => {
      for (const t of turns) {
        const job = getJob<StreamJob<AgentAnswer>>(`home:${t.id}`);
        if (job?.status !== "done") continue;
        const 答 = (job.value?.answer?.text ?? job.value?.text ?? "").trim();
        if (!认落(scope, t.id)) continue;
        if (!答) continue;
        const r = await 落一轮({
          conversationId: 当前对话(scope),
          question: t.question,
          answer: 答,
          model,
          ms: job.value?.ms ?? null,
          steps: job.value?.steps,
          // 建议卡不存：它是一件当时就处理完的事，翻历史不该再摆回来。背调的整份报告存着：翻历史还是那张卡
          refs: { records: job.value?.answer?.records ?? [], customers: job.value?.answer?.customers ?? [], ...(job.value?.answer?.research ? { research: job.value.answer.research } : {}) },
          标题前缀: 标题前缀,
          // 新建那条对话时记下「在哪一页问的」。标题前缀是给人看的，这个才是键
          scope,
        });
        认领对话(scope, r.conversationId);
        /*
          地址对上那条对话（replace：翻历史时后退键不该退回「同一屏但没有 ?c=」）。
          **只在首页做**：窄模式下人在客户页顺手问一句，把地址改成 /dashboard 就是把他跳走了。
        */
        if (模式 === "宽") router.replace(`/dashboard?c=${r.conversationId}`, { scroll: false });
        // 中栏那条列表要跟着出现 / 换顺序
        router.refresh();
      }
    })();
  }, [turns, runningKey, model, router, 模式, scope, 标题前缀]);
  const running = runningKey ? turns.find((t) => `home:${t.id}` === runningKey) : undefined;
  const queued = turns.find((t) => t.queued);

  /**
   * 把这一问之前已经答完的几轮带上去，模型才接得住「他」「那个」「再约一下」。
   *
   * 只取答完的：还在流的那条文本是半截的，喂回去只会让它照着半截往下编。
   * 条数和长度这里先收一道，服务端还会再收一道——上下文是要按 token 付钱的，
   * 而且它会原样进 prompt，两边都不能只信对方。
   */
  function 收集上下文(到: string): { q: string; a: string }[] {
    const out: { q: string; a: string }[] = [];
    for (const t of turns) {
      if (t.id === 到) break;
      const job = getJob<StreamJob<AgentAnswer>>(`home:${t.id}`);
      if (job?.status !== "done") continue;
      const a = (job.value?.answer?.text ?? job.value?.text ?? "").trim();
      if (a) out.push({ q: t.question, a });
    }
    return out.slice(-6);
  }

  function start(turn: Turn) {
    // 背调那一轮不在这里开跑：先出确认卡（扣几次、还剩几次），人点「开始」才跑，见 components/research/ResearchRun
    if (AI已用完 || turn.kind === "research") return;
    runStream<AgentAnswer>(
      `home:${turn.id}`,
      { mode: "agent", question: turn.question, model, history: 收集上下文(turn.id), files: turn.files, pageContext: 上下文提示, pageScope: 上下文范围 },
      undefined,
      // 带上标签，这一问就会出现在侧栏的「AI 任务」里：切去别的页面也看得见它跑完没有，
      // 点一下回到这一条。问题本身当名字，截短到一行
      // 窄模式下人在别的页面问的，点任务不该把他拽去首页——留在原地，面板里那一条就是
      { 名: turn.question.slice(0, 18), 去: 模式 === "宽" ? `/dashboard#turn-${turn.id}` : undefined },
    );
  }

  /*
    排队的下一问：前一问一停（答完 / 出错 / 被打断）就自动发出去。
    只该在「谁在跑、谁在排队、还有没有次数」变了的时候判断一次；发的时候用的是这一刻的 scope、模型、上下文——
    start 每次渲染都是新函数，放进依赖会让它每次渲染都跑，所以包成 effect event
  */
  const 发排队的 = useEffectEvent((t: Turn) => {
    dequeueTurn(scope, t.id);
    start(t);
  });
  useEffect(() => {
    if (running || !queued || AI已用完) return;
    发排队的(queued);
  }, [running, queued, AI已用完]);

  /*
    Esc：打断正在跑的那一问（页面任何地方按都行）。⌘K 聚焦在 AskBox 里，两页共用一份。
    **只接没人要的那一下**（审查 M7）：关斜杠菜单、关跳转单、关日期选择、取消输入法拼音时，
    Esc 是给最上面那一层的，不该顺手把底下已经花了次数的回答打断。判断在 lib/esc.ts
  */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!running || Esc归别人(e)) return;
      cancelStream(`home:${running.id}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running]);

  return { turns, runningKey, running, start, AI已用完 };
}

export type 这一屏 = ReturnType<typeof useHomeTurns>;
