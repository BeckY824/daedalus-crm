/**
 * agent 循环（ReAct，JSON 协议）。
 *
 * 不依赖网关的 function calling：每一步让模型只输出严格 JSON——
 *   {"thought": "一句话打算", "action": {"tool": "get_customer", "args": {...}}}   → 执行工具，把结果喂回去
 *   {"final": true}                                                              → 结束循环，进入最终回答
 * 最终回答用流式文本（Markdown），逐 token 推给浏览器；句末 [n] 引用工具读到的记录。
 *
 * 边界：工具全部只读；最多 6 步；每步与最终回答都有超时；用户按 Esc 时 signal 中断。
 * 过程通过 emit 推出去：每次工具调用一条 step（running → done + summary）。
 */
import { chatMessagesJSON, chatTextStream, buildSystemPrompt, type ChatMessage } from "../llm";
import { TOOLS, TOOL_MAP, type ToolContext } from "./tools";
import type { Emit } from "../ai-steps";
import type { BriefRecord } from "../ai-draft";
import type { BusinessConfig } from "../business-config";
import { dayjs } from "../utils";

export type AgentEvents = {
  emit?: Emit;
  onToken?: (text: string) => void;
  signal?: AbortSignal;
};

export type AgentResult = {
  text: string;
  records: BriefRecord[];
  /** 回答里提到的客户，前端据此给「打开记录页 / 起草话术」动作 */
  customers: { id: string; name: string; followStatus: string }[];
  steps: number;
};

const MAX_STEPS = 6;

export async function runAgent(input: { question: string; user: { id: string; name: string }; b: BusinessConfig }, ev: AgentEvents = {}): Promise<AgentResult> {
  const { question, user, b } = input;
  const toolDoc = TOOLS.map((t) => `- ${t.name}：${t.description}\n  参数：${t.args}`).join("\n");
  const system =
    buildSystemPrompt(b.brief).replace(/必须只输出用户要求的 JSON[^。]*。?/, "") +
    `\n你是销售「${user.name}」的助手，回答关于${b.customer}和业务数字的问题。现在是 ${dayjs().format("YYYY-MM-DD HH:mm")}（周${"日一二三四五六"[dayjs().day()]}）。
你能调用的工具（全部只读，你不能改任何数据）：
${toolDoc}

工作方式：每一轮只输出严格 JSON，二选一：
  {"thought": "一句话：打算干什么、为什么", "action": {"tool": "工具名", "args": {...}}}
  {"final": true}
规则：
- 问到某个人，先 search_customers（用问题里出现的完整姓名，不要只截一个姓）再 get_customer；同名多位时不要猜，直接 final 并在回答里说清楚有哪几位
- 问数字用 query_metric；问"该联系谁"用 get_watchlist / get_my_plans
- 已经拿到足够信息就 final，不要重复调用同一个工具
- 最多 ${MAX_STEPS} 步`;

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: `问题：${question}` },
  ];
  const ctx: ToolContext = { userId: user.id, userName: user.name, b, recordOffset: 0 };
  const records: BriefRecord[] = [];
  const customers = new Map<string, { id: string; name: string; followStatus: string }>();
  let steps = 0;

  for (let i = 0; i < MAX_STEPS; i++) {
    if (ev.signal?.aborted) throw new Error("已取消");
    const raw = (await chatMessagesJSON(messages, { maxTokens: 1500, timeoutMs: 60_000, signal: ev.signal })) as Record<string, unknown>;
    if (raw?.final || !raw?.action) break;
    const action = raw.action as { tool?: unknown; args?: unknown };
    const tool = typeof action.tool === "string" ? TOOL_MAP.get(action.tool) : undefined;
    const thought = typeof raw.thought === "string" ? raw.thought.slice(0, 80) : "";
    if (!tool) {
      messages.push({ role: "assistant", content: JSON.stringify(raw) }, { role: "user", content: `没有叫「${String(action.tool)}」的工具。可用：${TOOLS.map((t) => t.name).join(", ")}` });
      continue;
    }
    steps += 1;
    const stepId = `tool-${i}`;
    const args = (action.args && typeof action.args === "object" ? action.args : {}) as Record<string, unknown>;
    const argText = Object.values(args).filter((v) => typeof v === "string" && v).join(", ");
    ev.emit?.({ id: stepId, label: `${tool.name}(${argText.slice(0, 40)})`, status: "running", detail: thought || undefined });
    let result;
    try {
      result = await tool.run(args, ctx);
    } catch (e) {
      result = { summary: "工具出错", data: { error: e instanceof Error ? e.message : "工具执行失败" } };
    }
    if (result.records?.length) {
      records.push(...result.records);
      ctx.recordOffset += result.records.length;
    }
    if (tool.name === "get_customer" && result.data && typeof result.data === "object" && "id" in result.data) {
      const d = result.data as { id: string; name: string; profile: string };
      const m = d.profile.match(/跟进状态「([^」]+)」/);
      customers.set(d.id, { id: d.id, name: d.name, followStatus: m?.[1] ?? "" });
    }
    ev.emit?.({ id: stepId, label: `${tool.name}(${argText.slice(0, 40)})`, status: "done", detail: result.summary });
    messages.push({ role: "assistant", content: JSON.stringify(raw) }, { role: "user", content: `工具 ${tool.name} 的结果：\n${JSON.stringify(result.data).slice(0, 6000)}` });
  }

  // 最终回答：流式 Markdown
  ev.emit?.({ id: "answer", label: "组织回答", status: "running" });
  const finalPrompt = `现在直接回答用户的问题。要求：
- 用给销售看的口语化中文，Markdown，短句短段；能用列表就用列表；不要空话
- 只基于工具结果，禁止编造；引用某条跟进记录时在句末标它的 [编号]
- 数字类问题：先一句结论，再给关键数字；不要把整张表抄一遍
- 如果是"该怎么推进"这类问题，给 3~5 条具体可执行的建议，并指出风险
- 不要再输出 JSON，不要提到"工具"这个词`;
  const text = await chatTextStream([...messages, { role: "user", content: finalPrompt }], { maxTokens: 1800, timeoutMs: 120_000, signal: ev.signal }, (t) => ev.onToken?.(t));
  ev.emit?.({ id: "answer", label: "组织回答", status: "done" });
  return { text, records, customers: [...customers.values()], steps };
}
