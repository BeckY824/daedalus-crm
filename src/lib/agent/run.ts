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
import { TOOLS, TOOL_MAP, PROPOSAL_VOCAB, type ToolContext } from "./tools";
import type { Proposal } from "./proposals";
import type { Emit } from "../ai-steps";
import type { BriefRecord } from "../ai-draft";
import type { BusinessConfig } from "../business-config";
import { dayjs } from "../utils";

export type AgentEvents = {
  emit?: Emit;
  /** 用哪个模型。上游已按白名单校验过 */
  model?: string;
  onToken?: (text: string) => void;
  signal?: AbortSignal;
};

export type AgentResult = {
  text: string;
  records: BriefRecord[];
  /** 回答里提到的客户，前端据此给「打开记录页 / 起草话术」动作 */
  customers: { id: string; name: string; followStatus: string }[];
  /** 写入提议：渲染成卡片，人点确认才落库 */
  proposals: Proposal[];
  steps: number;
};

const MAX_STEPS = 6;

/** 之前几轮的问答，用来理解「他」「那个」「再约一下」这类指代 */
export type HistoryTurn = { q: string; a: string };

/**
 * 把历史折进**当前这条 user 消息**，而不是插成一串独立的 user/assistant。
 *
 * 因为这个循环跑的是严格 JSON 协议：每一轮模型只能输出
 * {"thought":..,"action":..} 或 {"final":true}。要是往消息里塞几条自然语言的
 * assistant 回答，等于给它看了一堆"不按协议输出也行"的先例，它会开始直接
 * 回自然语言，整个循环就散了。折进一条消息里，协议不受影响。
 */
function 拼上下文(history: HistoryTurn[] | undefined, question: string): string {
  if (!history?.length) return `问题：${question}`;
  const 之前 = history.map((h, i) => `[${i + 1}] 我问：${h.q}\n    你答：${h.a}`).join("\n");
  return `这是我们之前的对话，只用来理解我这次说的「他」「那个」「再约一下」指的是谁、是什么。不要重复回答里面的内容：
${之前}

问题：${question}`;
}

/**
 * 最终回答的开头清洗器。
 *
 * 决策步和回答步共用一段对话，而那段对话里每一条 assistant 消息都是 JSON。
 * 模型被这个格式带着走，有一定概率在正文前先吐一行控制信令
 * （实测线上出现过 `{"final":true}` 原样流到用户屏幕上），
 * 提示词里写「不要再输出 JSON」并不能根除。
 *
 * 所以在流式出口再兜一道：开头的内容先攒着，确认不是 JSON 再放行。
 *   - 开头不是 `{` → 立刻放行，之后一路直通，正文里的花括号不受影响
 *   - 开头是 `{` → 等它闭合，整段丢掉，只放行后面的正文
 *   - 万一那段 JSON 把答案包在字段里 → 取出最长的那个字符串字段当正文
 *   - 攒满 400 字还没闭合 → 判定为误判，原样放行，宁可漏一次也不吞正文
 */
/**
 * 试着从「已经收到的开头」里剥掉控制信令。
 * 每次收到新 token 都整段重跑一遍——开头只有几十个字符，重解析的代价可以忽略，
 * 换来的是不必维护「围栏读到一半」「JSON 读到一半」这些跨 token 的中间状态。
 */
function 尝试剥离(raw: string): { 完成: false } | { 完成: true; 正文: string; 剥掉的: string } {
  let s = raw.replace(/^\s+/, "");
  if (!s) return { 完成: false }; // 还全是空白
  let 有围栏 = false;

  // 开头的代码围栏：等这一行收完，别把 ```jso 这种半截当正文放走
  if (s.startsWith("`")) {
    const nl = s.indexOf("\n");
    if (nl === -1) return { 完成: false };
    if (!/^`{3,}\s*(json)?$/i.test(s.slice(0, nl).trim())) return { 完成: true, 正文: raw, 剥掉的: "" };
    有围栏 = true;
    s = s.slice(nl + 1).replace(/^\s+/, "");
    if (!s) return { 完成: false };
  }

  if (s[0] !== "{") return { 完成: true, 正文: raw, 剥掉的: "" }; // 不是 JSON，原样放行
  const end = s.indexOf("}");
  if (end === -1) return { 完成: false };
  const 信令 = s.slice(0, end + 1);
  s = s.slice(end + 1).replace(/^\s+/, "");

  // 闭合围栏同样可能只到一半；开头有围栏就必须等到它，否则 ``` 会漏到正文里
  if (s.startsWith("`")) {
    const nl = s.indexOf("\n");
    if (nl === -1) return { 完成: false };
    s = s.slice(nl + 1).replace(/^\s+/, "");
  } else if (有围栏 && !s) {
    return { 完成: false };
  }
  return { 完成: true, 正文: s, 剥掉的: 信令 };
}

/**
 * 最终回答的开头清洗器。
 *
 * 决策步和回答步共用一段对话，而那段对话里每一条 assistant 消息都是 JSON。
 * 模型被这个格式带着走，有一定概率在正文前先吐一行控制信令
 * （线上真实出现过 `{"final":true}` 原样流到用户屏幕上），
 * 提示词里写「不要再输出 JSON」并不能根除，所以在流式出口再兜一道。
 *
 * 判断只做一次：开头不是 JSON 就立刻直通，正文里的花括号、代码块都不受影响。
 * 攒够 400 字还没闭合就判定为误判，原样放行——宁可漏剥一次，也不能吞正文。
 */
export function 开头清洗器(emit: (s: string) => void) {
  let buf = "";
  let 已放行 = false;
  let 待去前导空白 = false;
  let out = "";

  function 放行(s: string) {
    已放行 = true;
    buf = "";
    if (!s) return;
    out += s;
    emit(s);
  }

  return {
    推入(tok: string) {
      if (已放行) {
        // 信令与正文之间的空行可能跨 token 才到，放行后还要再吃掉一次
        let s = tok;
        if (待去前导空白) {
          s = s.replace(/^\s+/, "");
          if (!s) return;
          待去前导空白 = false;
        }
        out += s;
        emit(s);
        return;
      }

      buf += tok;
      const r = 尝试剥离(buf);
      if (!r.完成) {
        if (buf.length > 400) 放行(buf); // 判定为误判，原样吐出去
        return;
      }
      let 正文 = r.正文;
      if (r.剥掉的 && !正文) {
        // 整段就是一个信令：答案可能被包在某个字段里，取最长的字符串值
        try {
          const o = JSON.parse(r.剥掉的) as Record<string, unknown>;
          正文 = Object.values(o).filter((v): v is string => typeof v === "string").sort((a, b) => b.length - a.length)[0] ?? "";
        } catch { /* 不是合法 JSON 就当它没说话 */ }
        待去前导空白 = !正文; // 正文还在后面的 token 里，接住时再去一次空白
      }
      放行(正文);
    },
    /** 流结束时叫一次：把还攒在手里、始终没等到结论的开头吐出去，一个字都不能留在缓冲里 */
    收尾() {
      if (已放行 || !buf) return;
      const r = 尝试剥离(buf);
      放行(r.完成 ? r.正文 : buf);
    },
    文本: () => out,
  };
}

export async function runAgent(
  input: { question: string; user: { id: string; name: string }; b: BusinessConfig; history?: HistoryTurn[] },
  ev: AgentEvents = {},
): Promise<AgentResult> {
  const { question, user, b, history } = input;
  const toolDoc = TOOLS.map((t) => `- ${t.name}：${t.description}\n  参数：${t.args}`).join("\n");
  const system =
    buildSystemPrompt(b.brief).replace(/必须只输出用户要求的 JSON[^。]*。?/, "") +
    `\n你是销售「${user.name}」的助手，回答关于${b.customer}和业务数字的问题。现在是 ${dayjs().format("YYYY-MM-DD HH:mm")}（周${"日一二三四五六"[dayjs().day()]}）。
你能调用的工具：
${toolDoc}

取值表（propose_* 的参数只能用这里的词）：
${PROPOSAL_VOCAB}

工作方式：每一轮只输出严格 JSON，二选一：
  {"thought": "一句话：打算干什么、为什么", "action": {"tool": "工具名", "args": {...}}}
  {"final": true}
规则：
- 你不能修改任何数据。propose_* 工具只是生成一张建议卡，人在界面上点确认才真的写进去；提完在回答里说一句"已经给出建议，你确认一下"，不要说"我已经改好了"
- 只在人明确要求做某件事时才提议（"帮我记一笔""把他改成已签约""约下周三""新建一条线索"）；人只是问情况时不要提议
- **信息不全也要提**：建议卡本身就是表单，你不知道的字段留空，人会在卡片上补。绝对不要在回答里列一张"姓名：__ 电话：__"让人照格式打字，也不要因为"信息不够"就拒绝——那是把本该一次点完的事变成打一屏字
- 提了建议卡之后，回答里只说一句要点和还差什么，不要把卡片里已有的字段再抄一遍
- 问到某个人，先 search_customers（用问题里出现的完整姓名，不要只截一个姓）再 get_customer；同名多位时不要猜，直接 final 并在回答里说清楚有哪几位
- 问某一类人（某个学校 / 专业 / 跟进状态 / 我负责的，"有多少、分别是谁"）：search_customers 用那个关键词或过滤条件，它返回总数和名单，直接据此回答，不用逐个 get_customer
- 工具没找到时如实说"没有匹配的"，不要把关键词当成人名
- 问数字用 query_metric；问"该联系谁"用 get_watchlist / get_my_plans
- 已经拿到足够信息就 final，不要重复调用同一个工具
- 最多 ${MAX_STEPS} 步
- 问题前面可能附着我们之前的对话。它只用来解开指代（"他""这位""那个学校""再约一下"）；
  真正要回答的永远是最后那个"问题："。别把之前答过的内容再抄一遍，也别拿旧数字当现在的数字——
  该查还得查`;

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: 拼上下文(history, question) },
  ];
  const ctx: ToolContext = { userId: user.id, userName: user.name, b, recordOffset: 0, proposals: [] };
  const records: BriefRecord[] = [];
  const customers = new Map<string, { id: string; name: string; followStatus: string }>();
  const mentioned = new Map<string, { id: string; name: string; followStatus: string }>();
  let steps = 0;

  for (let i = 0; i < MAX_STEPS; i++) {
    if (ev.signal?.aborted) throw new Error("已取消");
    // 决策步：关思维链、温度 0——只是选工具填参数，要快、要稳
    const t0 = Date.now();
    const raw = (await chatMessagesJSON(messages, { maxTokens: 1500, timeoutMs: 90_000, temperature: 0, thinking: false, model: ev.model, signal: ev.signal })) as Record<string, unknown>;
    console.info(`[agent] 第 ${i + 1} 步决策 ${Date.now() - t0}ms：${JSON.stringify(raw).slice(0, 120)}`);
    // 模型常把 final 塞进 action 里（{"action":{"final":true}}），或把 tool 直接放顶层：都认
    const action = ((raw?.action && typeof raw.action === "object" ? raw.action : raw) ?? {}) as { tool?: unknown; args?: unknown; final?: unknown };
    if (raw?.final || action.final || typeof action.tool !== "string") break;
    const tool = TOOL_MAP.get(action.tool);
    const thought = typeof raw.thought === "string" ? raw.thought.slice(0, 80) : "";
    if (!tool) {
      messages.push({ role: "assistant", content: JSON.stringify(raw) }, { role: "user", content: `没有叫「${String(action.tool)}」的工具。可用：${TOOLS.map((t) => t.name).join(", ")}` });
      continue;
    }
    steps += 1;
    const stepId = `tool-${i}`;
    const args = (action.args && typeof action.args === "object" ? action.args : {}) as Record<string, unknown>;
    const argText = Object.values(args).filter((v) => typeof v === "string" && v).join(", ");
    ev.emit?.({ id: stepId, label: `${tool.name}(${argText.slice(0, 40)})`, status: "running", thought: thought || undefined });
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
    } else {
      // 搜索 / 盯盘 / 计划里出现过的人先记着，回答里提到了才给动作
      for (const r of listCustomers(result.data)) mentioned.set(r.id, r);
    }
    ev.emit?.({ id: stepId, label: `${tool.name}(${argText.slice(0, 40)})`, status: "done", detail: result.summary, thought: thought || undefined });
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
  const 清洗 = 开头清洗器((s) => ev.onToken?.(s));
  await chatTextStream([...messages, { role: "user", content: finalPrompt }], { maxTokens: 1800, timeoutMs: 120_000, model: ev.model, signal: ev.signal }, (t) => 清洗.推入(t));
  清洗.收尾();
  const text = 清洗.文本();
  ev.emit?.({ id: "answer", label: "组织回答", status: "done" });
  for (const r of mentioned.values()) if (!customers.has(r.id) && customers.size < 5 && text.includes(r.name)) customers.set(r.id, r);
  return { text, records, customers: [...customers.values()], proposals: ctx.proposals, steps };
}

/** 从工具结果里捞出「id + 姓名」的行（搜索名单、盯盘、计划的形状各不同，只认字段名） */
function listCustomers(data: unknown): { id: string; name: string; followStatus: string }[] {
  const rows: unknown[] = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as { customers?: unknown }).customers) ? (data as { customers: unknown[] }).customers : [];
  const out: { id: string; name: string; followStatus: string }[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as { id?: unknown; customerId?: unknown; name?: unknown; followStatus?: unknown };
    const id = typeof o.id === "string" ? o.id : typeof o.customerId === "string" ? o.customerId : "";
    if (id && typeof o.name === "string") out.push({ id, name: o.name, followStatus: typeof o.followStatus === "string" ? o.followStatus : "" });
  }
  return out;
}
