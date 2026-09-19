"use client";

/**
 * 库里的一条对话 → 屏上的那几轮。
 *
 * **为什么在 lib 而不在 HomeChat 里。** 这段原来是 dashboard/HomeChat.tsx 里的
 * 一个私有函数，因为只有首页要用：首页的会话由服务端读好当 prop 传进来。
 * 0.39.2 起全局面板也能翻自己这一页的历史（面板头上那枚「历史」），
 * 而面板是在**点开的时候**才去要数据的——它没有那个 prop。
 * 两处必须摊成完全一样的形状（turn 的 id 决定 ai-jobs 的 key），
 * 各写一份迟早会分叉，所以挪出来一份，并且给它补上用例。
 */
import { setJobValue } from "./ai-jobs";
import { 认步骤 } from "./ai-steps";
import { 载入对话, type Turn } from "./home-thread";
import type { BriefRecord } from "./ai-draft";
import type { Proposal } from "./agent/proposals";
import type { StreamJob } from "./ai-stream";

/** 库里的一条消息。落库那头见 dashboard/threads.ts */
export type 历史消息 = {
  id: string;
  role: "user" | "assistant";
  text: string;
  model: string | null;
  ms: number | null;
  steps: unknown;
  refs: unknown;
  createdAt: string;
};

export type AgentAnswer = {
  text: string;
  records: BriefRecord[];
  customers: { id: string; name: string; followStatus: string }[];
  proposals: Proposal[];
};

/** 一条对话，读出来的样子。首页由服务端传进来，面板点开时自己去要 */
export type 会话 = { id: string; title: string; messages: 历史消息[] };

/**
 * 把库里读回来的消息摊成这一屏的「轮」。
 *
 * 一轮 = 一条 user + 紧跟着的一条 assistant。turn 的 id 直接用那条 user 消息的 id，
 * 这样 ai-jobs 里的 key（home:<id>）在刷新前后是同一个，不会翻一次历史多出一份任务。
 *
 * 落单的消息整轮跳过：一条 user 后面没跟 assistant（答之前进程没了），
 * 或者顺序被别的东西插花了。屏上宁可少一轮，也不要一个问着没人答的气泡。
 *
 * **建议卡不还原**：那是「要不要写进库」的待办，人当时已经处理过了；
 * 隔天翻历史再弹一张「点确认就写入」的卡片，等于把一件做完的事重新摆回台面。
 */
export function 历史成屏(messages: 历史消息[]): { turns: Turn[]; jobs: { key: string; value: StreamJob<AgentAnswer> }[] } {
  const turns: Turn[] = [];
  const jobs: { key: string; value: StreamJob<AgentAnswer> }[] = [];
  for (let i = 0; i < messages.length; i++) {
    const u = messages[i];
    if (u.role !== "user") continue;
    const a = messages[i + 1]?.role === "assistant" ? messages[i + 1] : null;
    if (!a) continue;
    i++;
    turns.push({ id: u.id, question: u.text, kind: "ask", at: Date.parse(u.createdAt) });
    const refs = (a.refs ?? {}) as { records?: BriefRecord[]; customers?: AgentAnswer["customers"] };
    jobs.push({
      key: `home:${u.id}`,
      value: {
        steps: 认步骤(a.steps),
        text: a.text,
        ms: a.ms ?? undefined,
        answer: { text: a.text, records: refs.records ?? [], customers: refs.customers ?? [], proposals: [] },
      },
    });
  }
  return { turns, jobs };
}

/**
 * 装进某一屏：轮放进 home-thread，答案放进 ai-jobs。
 *
 * 幂等由 载入对话 把着（同一条对话重复调不重置）——从别的页面切回首页会重新
 * 渲染一次，那时候不能把正在流的那一轮冲掉。返回 false = 这一屏本来就是它，没动。
 * 答案只在真的换了内容时才写：白写一遍会把 startedAt 刷新，侧栏那条任务跟着跳。
 */
export function 载入历史(scope: string, 会话: 会话): boolean {
  const { turns, jobs } = 历史成屏(会话.messages);
  // 「历史那几轮本来就在库里、别再落一遍」由 载入对话 一并认掉，见 home-thread
  if (!载入对话(scope, 会话.id, turns)) return false;
  for (const j of jobs) setJobValue(j.key, j.value);
  return true;
}
