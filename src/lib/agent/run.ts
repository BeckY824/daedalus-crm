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
import { chatMessagesJSON, chatTextStream, buildSystemPrompt, type ChatMessage, chatTools, type ToolMessage} from "../llm";
import { TOOLS, TOOL_MAP, proposalVocab, type ToolContext } from "./tools";
import { SCHEMAS } from "./schemas";
import { 认意图 } from "./intents";
import type { Proposal } from "./proposals";
import type { Emit } from "../ai-steps";
import type { BriefRecord } from "../ai-draft";
import type { BusinessConfig } from "../business-config";
import { dayjs } from "../utils";
import { 号码脱敏器 } from "../shared-ws/current";

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

/**
 * 「关于数据有没有」的论断。只在**一次工具都没调**时用来拦回答——
 * 那时模型手上一条数据都没有，说这种话必然是编的。
 * 查过工具的回答不走这里：那时「没有匹配的」是如实回答，正是我们要它说的。
 */
export function 凭空断言(text: string): boolean {
  return /(还?没有(任何|登记|录入|建立|添加)|一个都没有|一条都没有|一位都没有|都还没有|尚未(登记|录入|建立|添加)|(系统|库|里面)里?(还)?(没有|是空的)|暂无[^，。]{0,6}(数据|记录|渠道|客户|线索|商机)|目前(还)?没有)/.test(text);
}

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
  input: { question: string; user: { id: string; name: string }; b: BusinessConfig; history?: HistoryTurn[]; 页面上下文?: string },
  ev: AgentEvents = {},
): Promise<AgentResult> {
  const { question, user, b, history, 页面上下文 } = input;
  const toolDoc = TOOLS.map((t) => `- ${t.name}：${t.description}\n  参数：${t.args}`).join("\n");

  /**
   * **两条路的提示词不一样，而且这件事比看上去要命。**
   *
   * 第一版的原生 function calling 8 道题错 7 道，原因不是模型不会调工具——
   * 是系统提示词里还留着「工作方式：每一轮只输出严格 JSON」。模型老老实实照办了：
   * 它输出了一段 JSON 文本，而不是发起一次工具调用。**两套说明书同时给，它只会听一套。**
   * 所以原生这条路上，工具表和「怎么输出」这两段必须整个拿掉——工具在 API 的
   * `tools` 字段里，怎么调是模型自己训练过的事，我们不该再教一遍。
   */
  const 原生模式 = process.env.AGENT_TOOLCALLS !== "0";
  const 工作方式 = 原生模式
    ? `工作方式：需要数据就直接调用工具（可以连着调几次）；够了就不要再调，直接开口回答。`
    : `工作方式：每一轮只输出严格 JSON，二选一：
  {"thought": "一句话：打算干什么、为什么", "action": {"tool": "工具名", "args": {...}}}
  {"final": true}`;
  const system =
    buildSystemPrompt(b.brief).replace(/必须只输出用户要求的 JSON[^。]*。?/, "") +
    `\n你是销售「${user.name}」的助手，回答关于${b.customer}和业务数字的问题。现在是 ${dayjs().format("YYYY-MM-DD HH:mm")}（周${"日一二三四五六"[dayjs().day()]}）。
${原生模式 ? "" : `你能调用的工具：\n${toolDoc}\n`}
取值表（propose_* 的参数只能用这里的词）：
${proposalVocab(b)}

${工作方式}
规则：
- 你不能修改任何数据。propose_* 工具只是生成一张建议卡，人在界面上点确认才真的写进去；提完在回答里说一句"已经给出建议，你确认一下"，不要说"我已经改好了"
- 只在人明确要求做某件事时才提议（"帮我记一笔""把他改成已签约""约下周三""新建一条线索"）；人只是问情况时不要提议
- **信息不全也要提**：建议卡本身就是表单，你不知道的字段留空，人会在卡片上补。绝对不要在回答里列一张"姓名：__ 电话：__"让人照格式打字，也不要因为"信息不够"就拒绝——那是把本该一次点完的事变成打一屏字
- 提了建议卡之后，回答里只说一句要点和还差什么，不要把卡片里已有的字段再抄一遍
- 问到某个人，先 search_customers（用问题里出现的完整姓名，不要只截一个姓）再 get_customer；同名多位时不要猜，直接 final 并在回答里说清楚有哪几位
- 问某一类人（某个学校 / 专业 / 跟进状态 / 我负责的，"有多少、分别是谁"）：search_customers 用那个关键词或过滤条件，它返回总数和名单，直接据此回答，不用逐个 get_customer
- 工具没找到时如实说"没有匹配的"，不要把关键词当成人名
- 问数字用 query_metric；问"该联系谁"用 get_watchlist / get_my_plans
- 已经拿到足够信息就停下来回答，不要重复调用同一个工具
- 最多 ${MAX_STEPS} 步
- 问题前面可能附着我们之前的对话。它只用来解开指代（"他""这位""那个学校""再约一下"）；
  真正要回答的永远是最后那个"问题："。别把之前答过的内容再抄一遍，也别拿旧数字当现在的数字——
  该查还得查${
    页面上下文
      ? `
- **当前所在页面：${页面上下文}** 这是用户此刻正在看的东西，用来解开"这些人""这一批""他"指的是谁、范围有多大。
  它不代替查库：该调工具还得调，只是把范围用上。用户明确问了别的范围时以他说的为准`
      : ""
  }`;

  const messages: ToolMessage[] = [
    { role: "system", content: system },
    { role: "user", content: 拼上下文(history, question) },
  ];

  /**
   * 决策这一步怎么问模型。
   *
   * **默认走原生 function calling**：把工具表按 `tools` 字段发过去，模型走它自己
   * 训练过的那条路。2026-09-18 实测，同一个 flash 模型在「我目前有哪些渠道」这种
   * 问题上，JSON 协议那条路想了 70 多秒还选错工具，原生这条 226 个 prompt token
   * 就选对了——小模型要同时记住「输出格式」和「选哪个工具」，前者是白白占用的。
   *
   * 网关或模型不吃 `tools` 时（老的自部署、某些兼容层）第一次就会 4xx，
   * 那之后这一整轮退回原来的 JSON 协议。两条路都留着，因为用户填的是**他自己的**
   * 接口地址，我们没法假设对面支持什么。`AGENT_TOOLCALLS=0` 可以直接关掉原生。
   */
  const 工具表 = TOOLS.filter((t) => SCHEMAS[t.name]).map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: SCHEMAS[t.name] },
  }));
  let 用原生 = 原生模式 && 工具表.length > 0;

  /**
   * **意图直连**：固定的问题不问模型。
   *
   * 「有哪些渠道」「这个月谁签得最多」「今天该跟谁」的答案是一条确定的查询——
   * 业务逻辑和字段是固定的，不该每次让模型重新推理一遍。命中就直接跑工具，
   * 省掉一次决策往返（十几秒），也不留抖动的余地：同一句话永远走同一条路。
   * 模型只负责最后把数据说成人话，那一步它很稳。
   *
   * 没命中的照常走下面的循环——那条路要处理的是真正开放的问题。
   * 没命中的问句记一行日志，加规则时照着真实问句加，不拍脑袋。
   * `AGENT_INTENTS=0` 关掉（对照实验用）。
   */
  const 直连 = process.env.AGENT_INTENTS === "0" ? null : 认意图(question, Boolean(history?.length));
  if (直连) console.info(`[intent] 命中「${直连.名}」：${直连.调用.map((c) => c.name).join(" → ")}`);
  else console.info(`[intent] 没命中：${question.slice(0, 60)}`);
  /*
    号码脱敏器一并交给工具（2026-09-19 补的洞）。共享工作区里表格显示 `139****1111`，
    而 AI 工具原来是**没人接上的第四个出口**——问一句就能拿到完整号码，
    还会原样写进回答和对话存档。见 lib/shared-ws/current.ts。
  */
  const ctx: ToolContext = { userId: user.id, userName: user.name, b, recordOffset: 0, proposals: [], 号: await 号码脱敏器() };
  const records: BriefRecord[] = [];
  const customers = new Map<string, { id: string; name: string; followStatus: string }>();
  const mentioned = new Map<string, { id: string; name: string; followStatus: string }>();
  let steps = 0;

  /** 直连命中时先跑掉的那几个工具；循环里按下标认，跑完就轮到模型组织回答 */
  const 待跑 = 直连 ? [...直连.调用] : [];
  /** 已经真正跑过几个工具。为 0 时模型要作答，说明它手上一条数据都没有 */
  let 查过的工具 = 0;
  /** 空手作答只顶一次，免得来回拉锯 */
  let 顶过 = false;
  /** 这一轮调过哪些「工具 + 参数」，值是当时的结果摘要。用来拦原地打转 */
  const 调过的 = new Map<string, string>();

  for (let i = 0; i < MAX_STEPS; i++) {
    if (ev.signal?.aborted) throw new Error("已取消");
    // 决策步：关思维链、温度 0——只是选工具填参数，要快、要稳
    const t0 = Date.now();
    /** 这一步选了哪个工具、参数是什么、心里怎么想的；四条路（直连 / 原生 / JSON / 出错）都归到这个形 */
    let 选择: { tool: string; args: Record<string, unknown>; thought: string; 回执: ToolMessage[] } | null = null;

    /* 直连的工具还没跑完：直接取下一个，这一步完全不问模型 */
    if (待跑.length) {
      const c = 待跑.shift()!;
      if (TOOL_MAP.get(c.name)) {
        选择 = {
          tool: c.name,
          args: c.args,
          thought: `按「${直连!.名}」直接查`,
          // 直连没有模型的那轮对话，用一问一答两条消息把结果塞回上下文，供最后组织回答用
          回执: [
            { role: "assistant", content: `调用 ${c.name}` },
            { role: "user", content: "" },
          ],
        };
      }
    }

    if (!选择 && 用原生) {
      try {
        const r = await chatTools(messages, 工具表, { maxTokens: 1500, timeoutMs: 60_000, temperature: 0, thinking: false, model: ev.model, signal: ev.signal });
        console.info(`[agent] 第 ${i + 1} 步决策（原生）${Date.now() - t0}ms：${r.toolCalls.map((c) => c.function.name).join(",") || "没调工具"}`);
        /*
          没调工具 = 它认为够了，可以去组织回答。

          **但第一步就没调是另一回事**：那时上下文里一条数据都没有，
          而最终提示词写着「只基于工具结果」——手上没有工具结果，它就自己编。
          2026-09-18 线上真出过：问「我现在有什么渠道」，一个工具没调，
          直接答「还没有登记任何渠道」，而库里有一个。凭空断言用户的数据
          比答不上来严重得多——用户没法分辨哪句是查过的、哪句是编的。

          所以第一步空手时顶回去一次。再空手就放它走：确实有不用查库的问题
          （「你能做什么」「刚才那条帮我改改措辞」），顶两次纯属浪费时间。
        */
        if (!r.toolCalls.length) {
          if (查过的工具 === 0 && !顶过) {
            顶过 = true;
            messages.push(
              { role: "assistant", content: r.text || "（直接作答）" },
              {
                role: "user",
                content:
                  "你还没有查任何数据就要作答。凡是涉及这个 CRM 里的人、数字、记录的问题，" +
                  "都必须先调工具查过再回答——不许凭印象断言「没有」「一个都没登记」这类结论。" +
                  "如果这句话确实不需要查库（闲聊、改措辞、问你会什么），就直接回答。",
              },
            );
            continue;
          }
          break;
        }
        const c = r.toolCalls[0];
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          // 参数不是合法 JSON：交回去让它重来，比我们猜一个强
          messages.push(
            { role: "assistant", content: null, tool_calls: [c] },
            { role: "tool", tool_call_id: c.id, content: `参数不是合法 JSON：${c.function.arguments.slice(0, 200)}` },
          );
          continue;
        }
        选择 = {
          tool: c.function.name,
          args,
          thought: r.text.slice(0, 80),
          回执: [{ role: "assistant", content: r.text || null, tool_calls: [c] }],
        };
        if (!TOOL_MAP.get(c.function.name)) {
          messages.push(...选择.回执, { role: "tool", tool_call_id: c.id, content: `没有叫「${c.function.name}」的工具。可用：${工具表.map((t) => t.function.name).join(", ")}` });
          continue;
        }
        // 结果要按 tool_call_id 回去，记下来给下面用
        选择.回执.push({ role: "tool", tool_call_id: c.id, content: "" });
      } catch (e) {
        // 对面不吃 tools：这一整轮退回 JSON 协议，不再试
        用原生 = false;
        console.warn(`[agent] 原生 function calling 不可用，退回 JSON 协议：${e instanceof Error ? e.message.slice(0, 160) : e}`);
      }
    }

    if (!选择) {
      const raw = (await chatMessagesJSON(messages, { maxTokens: 1500, timeoutMs: 90_000, temperature: 0, thinking: false, model: ev.model, signal: ev.signal })) as Record<string, unknown>;
      console.info(`[agent] 第 ${i + 1} 步决策 ${Date.now() - t0}ms：${JSON.stringify(raw).slice(0, 120)}`);
      // 模型常把 final 塞进 action 里（{"action":{"final":true}}），或把 tool 直接放顶层：都认
      const action = ((raw?.action && typeof raw.action === "object" ? raw.action : raw) ?? {}) as { tool?: unknown; args?: unknown; final?: unknown };
      if (raw?.final || action.final || typeof action.tool !== "string") break;
      if (!TOOL_MAP.get(action.tool)) {
        messages.push({ role: "assistant", content: JSON.stringify(raw) }, { role: "user", content: `没有叫「${String(action.tool)}」的工具。可用：${TOOLS.map((t) => t.name).join(", ")}` });
        continue;
      }
      选择 = {
        tool: action.tool,
        args: (action.args && typeof action.args === "object" ? action.args : {}) as Record<string, unknown>,
        thought: typeof raw.thought === "string" ? raw.thought.slice(0, 80) : "",
        回执: [{ role: "assistant", content: JSON.stringify(raw) }, { role: "user", content: "" }],
      };
    }

    const tool = TOOL_MAP.get(选择.tool)!;
    const thought = 选择.thought;
    const args = 选择.args;

    /*
      **同一个工具、同一套参数，第二次就别再跑了。**

      2026-09-19 报上来的：在线索页问「Steven 是哪家公司的？」，过程条上
      `search_customers() → 没给条件` 连着四行，一条数据都没查着。
      Steven 是那条线索的联系人，在 Lead 表里——search_customers 翻的是 Customer 表，
      给什么参数都查不到他。而工具原样把同一句「没给条件」退回去，
      模型读到的等于「再试一次」，于是原地打转到步数用完。

      这里不重复执行，直接把「换个工具」这件事说给它听，并且**把候选列出来**：
      提示词里那句「不要重复调用同一个工具」它已经看过了，没用——
      空泛的禁止改不了它的选择，给出下一步该做什么才行。
    */
    const 签名 = `${tool.name}:${JSON.stringify(args)}`;
    if (调过的.has(签名)) {
      const 劝 =
        `你刚才已经用完全相同的参数调过 ${tool.name} 了，结果还是那一个：${调过的.get(签名)}。` +
        `再调一次不会有不同的结果。要么换一套参数，要么换一个工具——可用的：` +
        `${TOOLS.filter((t) => SCHEMAS[t.name] && t.name !== tool.name).map((t) => t.name).join("、")}。` +
        `线索（list_leads）、商机（list_opportunities）、渠道（list_channels）和客户（search_customers）是**不同的表**，` +
        `在一张表里查不到的东西要换一张表查。都查不到就直接作答，如实说没找到。`;
      // 回执的最后一条是留给结果的占位：原生那条按 tool_call_id 对上，JSON 协议那条是 user
      const 回执 = 选择.回执;
      (回执[回执.length - 1] as { content: string }).content = 劝;
      messages.push(...回执);
      console.warn(`[agent] 原地打转，拦下第二次 ${签名.slice(0, 80)}`);
      continue;
    }

    steps += 1;
    const stepId = `tool-${i}`;
    const argText = Object.values(args).filter((v) => typeof v === "string" && v).join(", ");
    ev.emit?.({ id: stepId, label: `${tool.name}(${argText.slice(0, 40)})`, status: "running", thought: thought || undefined });
    let result;
    try {
      result = await tool.run(args, ctx);
      查过的工具 += 1;
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
    调过的.set(签名, result.summary);
    ev.emit?.({ id: stepId, label: `${tool.name}(${argText.slice(0, 40)})`, status: "done", detail: result.summary, thought: thought || undefined });
    // 结果交回去：原生那条按 tool_call_id 对上，JSON 协议那条还是一条 user 消息
    const 结果文本 = `工具 ${tool.name} 的结果：\n${JSON.stringify(result.data).slice(0, 6000)}`;
    const 回执 = 选择.回执;
    const 末 = 回执[回执.length - 1] as { role: string; content: string };
    末.content = 末.role === "tool" ? JSON.stringify(result.data).slice(0, 6000) : 结果文本;
    messages.push(...回执);

    /*
      直连的工具跑完就直接去组织回答。**不 break 的话它会白问一次模型**
      （下一轮 待跑 空了，就落进决策分支，模型答「不用再调工具了」）——
      那正是直连想省掉的那次往返，第一版就漏在这儿：对照里 C 反而比 A 慢，
      量了才发现决策步中位 7.4 秒一分没省。
    */
    if (直连 && !待跑.length) break;
  }

  // 最终回答：流式 Markdown
  ev.emit?.({ id: "answer", label: "组织回答", status: "running" });
  const finalPrompt = `现在直接回答用户的问题。要求：
- 用给销售看的口语化中文，Markdown，短句短段；能用列表就用列表；不要空话
- 只基于工具结果，禁止编造；引用某条跟进记录时在句末标它的 [编号]
- 数字类问题：先一句结论，再给关键数字；不要把整张表抄一遍
- 如果是"该怎么推进"这类问题，给 3~5 条具体可执行的建议，并指出风险
- 不要再输出 JSON，不要提到"工具"这个词`;
  /** 跑一次最终回答。静默时只把文本拿回来，不往界面推 token */
  const 组织回答 = async (提示: string, 静默: boolean) => {
    const 清洗 = 开头清洗器((t) => { if (!静默) ev.onToken?.(t); });
    await chatTextStream([...messages, { role: "user", content: 提示 }], { maxTokens: 1800, timeoutMs: 120_000, model: ev.model, signal: ev.signal }, (t) => 清洗.推入(t));
    清洗.收尾();
    return 清洗.文本();
  };

  /*
    **一次工具都没调，还敢下「没有」这种结论的，拦下来重答。**

    循环里那道闸（第一步空手就顶回去）只顶一次——顶完它还是不查，就放它来组织回答了。
    到这儿手上依然一条数据都没有，而它会照样写出「查了一下，系统里还没有登记任何渠道」。
    2026-09-18 线上就是这么发生的，库里明明有一个。

    用户分辨不出哪句是查过的、哪句是编的，所以这类断言一个都不能放过去。
    这里只拦**最伤的那一种**：零工具 + 关于数据有没有的论断。别的照放——
    「你能做什么」「帮我改改措辞」本来就不需要查库。

    代价是零工具那次要先攒完再推（多等一个回答的时间），不流式。
    但零工具本来就该是极少数，而让用户眼睁睁看着一句编的话逐字蹦出来更糟。

    重答时不再试图逼它查——上面已经逼过一次了。这一轮只要求它**说实话**：
    拿不到数据就说拿不到。答不上来是可以接受的，编是不可以的。
  */
  const 零工具 = 查过的工具 === 0;
  let text = await 组织回答(finalPrompt, 零工具);
  if (零工具 && 凭空断言(text)) {
    console.warn(`[agent] 零工具却断言了数据，重答一次：${text.slice(0, 80)}`);
    text = await 组织回答(
      finalPrompt +
        `\n\n**重要**：你这一轮一次数据都没查过，所以你不知道库里有什么。` +
        `绝对不许出现「没有」「还没有登记」「一个都没有」「系统里是空的」这类关于数据的结论——那是编的。` +
        `如实说你需要先查一下，或者只回答不依赖库里数据的那部分。`,
      false,
    );
  } else if (零工具) {
    ev.onToken?.(text); // 攒着的那份验过了，原样推出去
  }
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
