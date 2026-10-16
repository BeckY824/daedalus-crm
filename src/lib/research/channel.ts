/**
 * 背调去哪儿搜、去哪儿读网页、找谁扣次数——「通道」。编排（run.ts）只认这四个动作，不管背后是谁。
 *
 *   云端    桌面端登录了我们的账号：打 /api/gateway/v1/research/*，设备令牌鉴权，扣的是这个账号的 AI 次数。
 *           搜索 Key 在服务器上（中转站自带的 Claude / GPT 搜索），桌面端永远拿不到
 *   模拟    开发、单测、e2e：不联网、不花钱，结果是编的（.example 域名），见 mock.ts
 *   没有    既没登录云端、也不是开发环境：背调用不了，界面上说清楚为什么
 *
 * 为什么自部署版不直连搜索服务：搜索 Key 只给我们的服务器配（10-16 定的），开源自部署的人没有这个 Key。
 * 真有人要，再加一个「直连」通道就是——编排一行不用改。
 */
import { 本地模式, 模型配置 as 云端模型配置 } from "../desktop/cloud";
import { 模型来源 } from "../llm-config";
import { 背调扣次, type 开始回应, type 搜索结果, type 读页结果, type 收尾回应 } from "./types";
import { 模拟通道 } from "./mock";

export type 背调通道 = {
  名: "云端" | "模拟";
  /** 这次背调扣几次（开跑前给人看的那个数） */
  扣次: number;
  /** 背调的分析用哪个模型：只用 GPT / Claude（10-16 用户定），网关白名单里没有就 undefined = 用默认 */
  模型?: string;
  开始(runId: string, signal?: AbortSignal): Promise<开始回应>;
  搜索(runId: string, query: string, signal?: AbortSignal): Promise<搜索结果[]>;
  读页(runId: string, url: string, signal?: AbortSignal): Promise<读页结果>;
  收尾(runId: string, ok: boolean, 用量: { searches: number; pages: number }): Promise<收尾回应 | null>;
};

export type 通道结果 = { ok: true; 通道: 背调通道 } | { ok: false; error: string };

/** 背调只用 GPT / Claude：在网关给的模型里挑，Claude 优先（检测里快一倍、能卡搜索次数） */
export function 挑背调模型(models: string[]): string | undefined {
  const ids = models.map((m) => m.split("|")[0].trim()).filter(Boolean);
  return ids.find((m) => /claude/i.test(m) && /sonnet/i.test(m)) ?? ids.find((m) => /claude/i.test(m)) ?? ids.find((m) => /^gpt/i.test(m));
}

/** 网关的错误体是 OpenAI 那套 { error: { message } }，取出那句中文 */
async function 读错(res: Response): Promise<string> {
  const t = await res.text().catch(() => "");
  try {
    const m = (JSON.parse(t) as { error?: { message?: string } }).error?.message;
    if (m) return m;
  } catch {
    /* 不是 JSON：下面按状态码说 */
  }
  if (res.status === 401) return "登录已失效，请在桌面端重新登录";
  if (res.status === 404) return "服务器还没开通背调，请稍后再试";
  return `背调服务出错了（${res.status}），稍后再试`;
}

export function 云端通道(cfg: { baseUrl: string; apiKey: string; models: string[] }, 走我们的模型: boolean): 背调通道 {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const 发 = async <T>(路: string, body: unknown, signal?: AbortSignal, 秒 = 60): Promise<T> => {
    const res = await fetch(`${base}/research/${路}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(秒 * 1000)]) : AbortSignal.timeout(秒 * 1000),
    });
    if (!res.ok) throw Object.assign(new Error(await 读错(res)), { status: res.status });
    return (await res.json()) as T;
  };
  return {
    名: "云端",
    扣次: 走我们的模型 ? 背调扣次.走我们的模型 : 背调扣次.自己的模型,
    模型: 走我们的模型 ? 挑背调模型(cfg.models) : undefined,
    async 开始(runId, signal) {
      try {
        const r = await 发<开始回应>("start", { runId, 走我们的模型 }, signal, 20);
        // 背调用哪个模型听服务器的（背调专用模型不在平时的白名单里，只有这一笔放行）。编排每次调用现读 通道.模型
        if (r.ok && r.模型) this.模型 = r.模型;
        return r;
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "背调没能开始" };
      }
    },
    async 搜索(runId, query, signal) {
      return (await 发<{ results: 搜索结果[] }>("search", { runId, query }, signal, 60)).results ?? [];
    },
    async 读页(runId, url, signal) {
      return 发<读页结果>("read", { runId, url }, signal, 30);
    },
    async 收尾(runId, ok, 用量) {
      // 收尾失败不能让报告出不来：只是少记一笔账 / 少退一次，打一行日志
      try {
        return await 发<收尾回应>("finish", { runId, ok, ...用量 }, undefined, 15);
      } catch (e) {
        console.warn("[research] 收尾没记上：", e instanceof Error ? e.message : e);
        return null;
      }
    },
  };
}

/**
 * 这台机器上背调走哪条通道。
 *
 * CRM_RESEARCH_CHANNEL=mock 强制走模拟（e2e、演示）；开发环境没登录云端时也走模拟，省得每次开发都要登录。
 * 正式环境没登录云端就是用不了——不偷偷退到模拟，那样人会拿一份编的报告当真。
 */
export async function 选通道(env: NodeJS.ProcessEnv = process.env): Promise<通道结果> {
  if (env.CRM_RESEARCH_CHANNEL === "mock") return { ok: true, 通道: 模拟通道() };
  const 云端 = 本地模式() ? 云端模型配置() : null;
  if (云端) {
    // 自己在设置里填了模型 Key 的：模型走他自己的，只有搜索走我们的服务器
    const 走我们的模型 = (await 模型来源()) !== "ui";
    return { ok: true, 通道: 云端通道(云端, 走我们的模型) };
  }
  if (env.NODE_ENV !== "production") return { ok: true, 通道: 模拟通道() };
  return { ok: false, error: 本地模式() ? "背调要联网搜索，请先在桌面端登录账号" : "背调目前只在桌面端可用" };
}
