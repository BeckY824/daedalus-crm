import { generateBrief } from "@/app/(app)/customers/[id]/ai";
import type { Emit } from "@/lib/ai-steps";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { consumeUserAiQuota } from "@/lib/ai-quota";
import { recordAiUse } from "@/lib/ai-usage";
import { type 页面范围 } from "@/lib/agent/intents";
import { runAgent } from "@/lib/agent/run";
import { resolveModel } from "@/lib/llm";
import { 收文件, 拼文件 } from "@/lib/ask-files";
import { 收客户页面筛选 } from "@/lib/ai-page-filters";
import { AI文本输入错误 } from "@/lib/ai-input";

/** 一个问题最多多长。300 太短，一句完整的业务问题经常就写不下 */
const 问题上限 = 1000;
/** 带几轮上下文。再多的收益递减，而每一轮都要跟着这次的 prompt 一起付钱 */
const 上下文轮数 = 6;
const 单问上限 = 200;
const 单答上限 = 600;
/**
 * 上下文来自浏览器，一律当成不可信输入重新收一遍。
 *
 * 它会被原样拼进发给模型的 prompt，所以这里既是防"传一兆字节把账单打爆",
 * 也是防"往历史里塞一段假的『你答：』来改写模型的行为"——
 * 后者拦不住内容，但至少把体量和条数钉死，让它翻不出浪。
 */
function 收上下文(v: unknown): { q: string; a: string }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .slice(-上下文轮数)
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
    .map((x) => ({
      q: typeof x.q === "string" ? x.q.trim().slice(0, 单问上限) : "",
      a: typeof x.a === "string" ? x.a.trim().slice(0, 单答上限) : "",
    }))
    .filter((x) => x.q && x.a);
  return out.length ? out : undefined;
}

import { 带额度 } from "@/lib/tenant/ai-allowance";

export const dynamic = "force-dynamic";

/**
 * AI 工作流的事件流（SSE）。
 *
 * 首页提问、快捷键、记录页简报都走这里而不是 Server Action：
 *   1. 过程可见——每个节点（识别问题 / 读取记录 / 生成）做完就推一条 step 给浏览器
 *   2. 不排队——Next 会把同一客户端的 Server Action 串行化，十几秒的模型调用会把
 *      「登记签约」这类保存动作排在后面等
 * 鉴权、配额、留痕都在被调用的动作里，这里只负责把 emit 接到响应流上。
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return new Response("请求格式不正确", { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return new Response("请求格式不正确", { status: 400 });
  if (body.mode === "agent") {
    const error = AI文本输入错误(body.question, 2, 问题上限, "请先输入要问的问题");
    if (error) return new Response(error, { status: 400 });
  }

  let 页面范围: 页面范围 | undefined;
  try { 页面范围 = 收页面范围(body.pageScope); }
  catch { return new Response("页面筛选格式不正确，请刷新页面后重试", { status: 400 }); }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const emit: Emit = (e) => send({ type: "step", at: Date.now(), ...e });
      try {
        /**
         * 试用期的免费次数：每一支各自套 带额度（lib/tenant/ai-allowance.ts）——
         * 过闸门、没给出答案就退、**用户自己中断的不退**（那一次上游已经在跑，钱是真花出去的）。
         * 简报那一支在 generateBrief 里面扣：它也是记录页之外能被直接调用的动作，
         * 扣在它身上才堵得住；这里再扣一次就成了一问两扣。自部署版不走闸门。
         */
        let res: { ok: true; answer: unknown } | { ok: false; error: string };
        if (body.mode === "agent" && typeof body.question === "string") {
          const question = body.question;
          res = await 带额度(
            "ask",
            async () => {
              const history = 收上下文(body.history);
              // agent：模型自己决定读谁、查什么，每次工具调用推一条 step，最终回答逐 token 推
              const user = await requireUser();
              const wait = consumeUserAiQuota(user);
              if (wait !== null) throw new Error(`AI 调用太频繁，请 ${wait} 秒后再试`);
              const b = await getBusiness();
              const abort = new AbortController();
              req.signal.addEventListener("abort", () => abort.abort());
              // 浏览器报上来的模型名不可信，按设置页的白名单收一遍
              const model = await resolveModel(typeof body.model === "string" ? body.model : undefined);
              const files = 收文件(body.files);
              const 问 = 拼文件(question.trim().slice(0, 问题上限), files);
              // 当前页的上下文。浏览器来的，收一道长度；空串当没给。
              // 上限从 300 放到 1200：现在还带着这一页上列着的名字（最多 50 个）
              const 页面 = typeof body.pageContext === "string" ? body.pageContext.trim().slice(0, 1200) : "";
              const 范围 = 页面范围;
              const r = await runAgent({ question: 问, user: { id: user.id, name: user.name }, b, history, 页面上下文: 页面 || undefined, 页面范围: 范围 }, { emit, model, onToken: (t) => send({ type: "token", text: t }), onReset: () => send({ type: "reset" }), signal: abort.signal });
              // 日志只记问题和文件**名**，不记文件内容——那张表全员可读
              await recordAiUse(
                user,
                "ask",
                `AI 对话：「${question.trim().slice(0, 60)}」（${r.steps} 次工具调用${model ? `，${model}` : ""}${files ? `，带了 ${files.map((f) => f.name).join("、")}` : ""}）`,
              );
              return { ok: true as const, answer: { text: r.text, records: r.records, customers: r.customers, proposals: r.proposals } };
            },
            { 中断: req.signal },
          );
        } else if (body.mode === "brief" && typeof body.customerId === "string") {
          const r = await generateBrief({ customerId: body.customerId, question: typeof body.question === "string" ? body.question : undefined }, emit);
          res = r.ok ? { ok: true, answer: { brief: r.brief, records: r.records } } : r;
        } else {
          res = { ok: false, error: "不认识的请求" };
        }
        send(res.ok ? { type: "result", ok: true, answer: res.answer } : { type: "result", ok: false, error: res.error });
      } catch (e) {
        // 次数该退的已经在 带额度 里退过了，这里只管把错误说成人话
        // requireUser 未登录时会 redirect()，在路由里表现为抛错
        const msg =
          e instanceof Error && /NEXT_REDIRECT/.test(e.message)
            ? "登录已失效，请刷新页面"
            : e instanceof Error && e.name === "TimeoutError"
              ? // 原来摆的是英文「The operation was aborted due to timeout」（2026-10-02）
                "AI 这次超时没回音，稍后再问一次试试"
              : e instanceof Error && e.name === "AbortError"
                ? "已停止"
                : e instanceof Error
                  ? e.message
                  : "生成失败";
        send({ type: "result", ok: false, error: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}


/**
 * 浏览器报上来的页面范围，逐个字段收一道。形状不对就当没给——
 * 它只影响意图直连走不走，给错了顶多退回模型那条路，不会出错答案。
 */
function 收页面范围(v: unknown): 页面范围 | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const 串 = (x: unknown, n: number) => (typeof x === "string" ? x.trim().slice(0, n) : "");
  const 表 = 串(o.表, 20), 工具 = 串(o.工具, 40), 参数 = 串(o.参数, 40);
  if (!表 || !/^[a-z_]+$/.test(工具) || !/^[a-zA-Z_]+$/.test(参数)) return undefined;
  const 名字 = Array.isArray(o.名字) ? o.名字.map((x) => 串(x, 40)).filter(Boolean).slice(0, 50) : [];
  let 筛选: 页面范围["筛选"];
  if (o.筛选 !== undefined) {
    const result = 收客户页面筛选(o.筛选);
    if (!result || 表 !== "客户" || 工具 !== "search_customers") throw new Error("页面筛选格式不正确");
    筛选 = result;
  }
  return { 表, 工具, 参数, 名字, ...(筛选 ? { 筛选 } : {}) };
}
