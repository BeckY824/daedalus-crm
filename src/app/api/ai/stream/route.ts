import { askHome, quickBrief } from "@/app/(app)/dashboard/ask";
import { generateBrief } from "@/app/(app)/customers/[id]/ai";
import type { Emit } from "@/lib/ai-steps";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { consumeAiQuota } from "@/lib/ai-quota";
import { recordAiUse } from "@/lib/ai-usage";
import { runAgent } from "@/lib/agent/run";

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
    return new Response("bad request", { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const emit: Emit = (e) => send({ type: "step", at: Date.now(), ...e });
      try {
        let res: { ok: true; answer: unknown } | { ok: false; error: string };
        if (body.mode === "agent" && typeof body.question === "string") {
          // agent：模型自己决定读谁、查什么，每次工具调用推一条 step，最终回答逐 token 推
          const user = await requireUser();
          const wait = consumeAiQuota(user.id);
          if (wait !== null) throw new Error(`AI 调用太频繁，请 ${wait} 秒后再试`);
          const b = await getBusiness();
          const abort = new AbortController();
          req.signal.addEventListener("abort", () => abort.abort());
          const r = await runAgent({ question: body.question.trim().slice(0, 300), user: { id: user.id, name: user.name }, b }, { emit, onToken: (t) => send({ type: "token", text: t }), signal: abort.signal });
          await recordAiUse(user, "ask", `AI 对话：「${body.question.trim().slice(0, 60)}」（${r.steps} 次工具调用）`);
          res = { ok: true, answer: { text: r.text, records: r.records, customers: r.customers } };
        } else if (body.mode === "home" && typeof body.question === "string") {
          res = await askHome(body.question, emit);
        } else if (body.mode === "quick" && (body.intent === "prep" || body.intent === "recap")) {
          res = await quickBrief(body.intent, emit);
        } else if (body.mode === "brief" && typeof body.customerId === "string") {
          const r = await generateBrief({ customerId: body.customerId, question: typeof body.question === "string" ? body.question : undefined }, emit);
          res = r.ok ? { ok: true, answer: { brief: r.brief, records: r.records } } : r;
        } else {
          res = { ok: false, error: "不认识的请求" };
        }
        send(res.ok ? { type: "result", ok: true, answer: res.answer } : { type: "result", ok: false, error: res.error });
      } catch (e) {
        // requireUser 未登录时会 redirect()，在路由里表现为抛错
        const msg = e instanceof Error && /NEXT_REDIRECT/.test(e.message) ? "登录已失效，请刷新页面" : e instanceof Error ? e.message : "生成失败";
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
