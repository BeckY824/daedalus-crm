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
import { 背调超时 } from "./retry";
import type { 开始回应, 搜索结果, 读页结果, 收尾回应, 价目回应, 花费, 搜索回应, 读页回应 } from "./types";
import { 模拟通道 } from "./mock";
import { 网关模型 } from "./gateway-model";
import type { 模型调用 } from "./run";
import type { 核验请求, 核验回应 } from "./verify/types";

export type 背调通道 = {
  名: "云端" | "模拟";
  /** 这次背调扣了几次（开始以后是服务器回的实数；开始前是 0） */
  扣次: number;
  /** 最后打分 + 写报告用哪个模型：服务器在 start 的回应里定（固定 gpt-5.5，「保证最后回复的质量」）；开始前是猜的 */
  模型?: string;
  /** 每一步挑工具、写摘要用哪个模型（服务器定，可以是便宜的 mini）；没有就和 模型 一样 */
  摘要模型?: string;
  /**
   * 背调的分析走哪儿。云端通道给：**直接打我们的模型网关**，不管这台机器在设置里填没填自己的 Key——
   * 背调的搜索和分析都用我们的服务、照价扣（10-16 总控定）。不给（模拟）就用本机配的模型（lib/llm.ts）
   */
  模型调用?: 模型调用;
  /** 到现在估计花了多少、上限多少：每次搜索 / 读页后服务器回的。编排据此在上限前停手（run.ts） */
  花费?: 花费;
  /** 开跑前问价：扣几次、还剩几次（不限 = 测试账号）。模拟通道不扣 */
  价目(signal?: AbortSignal): Promise<{ 扣次: number; 还剩: number | null; 不限?: boolean }>;
  开始(runId: string, signal?: AbortSignal): Promise<开始回应>;
  搜索(runId: string, query: string, signal?: AbortSignal): Promise<搜索结果[]>;
  读页(runId: string, url: string, signal?: AbortSignal): Promise<读页结果>;
  /**
   * 程序直查（域名、官网、邮箱、电话、制裁名单、工商库、税号）：不经模型、不另扣次数。
   * 回 null = 这次没核成（老服务器没有这个接口、超时、出错）：真实性那块照样出，那几项写「没核成」
   */
  核验(请求: 核验请求, signal?: AbortSignal): Promise<核验回应 | null>;
  /** ok = 6 步都跑完了；取消 = 用户自己停的。退不退服务器判断，回应里的 退了 > 0 就是退了 */
  收尾(runId: string, ok: boolean, 用量: { searches: number; pages: number; 取消?: boolean }): Promise<收尾回应 | null>;
};

export type 通道结果 = { ok: true; 通道: 背调通道 } | { ok: false; error: string };

/**
 * 背调只用 GPT / Claude：在网关给的模型里挑，**GPT 优先**（10-16 试跑：GPT 一次约 2.6 元、来源核得上 94%，
 * Claude 约 6 元）。只是开始前的猜测——真正用哪个听服务器 start 的回应
 */
export function 挑背调模型(models: string[]): string | undefined {
  const ids = models.map((m) => m.split("|")[0].trim()).filter(Boolean);
  return ids.find((m) => /^gpt/i.test(m)) ?? ids.find((m) => /claude/i.test(m) && /sonnet/i.test(m)) ?? ids.find((m) => /claude/i.test(m));
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

export function 云端通道(cfg: { baseUrl: string; apiKey: string; models: string[] }): 背调通道 {
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
  const 通道: 背调通道 = {
    名: "云端",
    扣次: 0,
    模型: 挑背调模型(cfg.models),
    模型调用: undefined,
    async 价目(signal) {
      const res = await fetch(`${base}/research/price`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw Object.assign(new Error(await 读错(res)), { status: res.status });
      const r = (await res.json()) as 价目回应;
      return { 扣次: r.扣次, 还剩: r.不限 ? null : r.还剩, 不限: r.不限 };
    },
    async 开始(runId, signal) {
      try {
        const r = await 发<开始回应>("start", { runId, 走我们的模型: true }, signal, 20);
        // 背调用哪个模型听服务器的（背调专用模型不在平时的白名单里，只有这一笔放行）。编排每次调用现读 通道.模型
        if (r.ok) {
          通道.扣次 = r.扣了;
          if (r.模型) 通道.模型 = r.模型;
          if (r.摘要模型) 通道.摘要模型 = r.摘要模型;
        }
        return r;
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "背调没能开始" };
      }
    },
    async 搜索(runId, query, signal): Promise<搜索结果[]> {
      // 服务器那头一次最多两趟（卡住重搜一次，或换备用那家），等它先到点（retry.ts 的 背调超时）
      const r = await 发<搜索回应>("search", { runId, query }, signal, 背调超时.搜索接口 / 1000);
      if (r.花费) 通道.花费 = r.花费;
      return r.results ?? [];
    },
    async 读页(runId, url, signal): Promise<读页结果> {
      const r = await 发<读页回应>("read", { runId, url }, signal, 30);
      if (r.花费) 通道.花费 = r.花费;
      return r;
    },
    async 核验(请求, signal) {
      // 服务器那头几项并行、每项自带超时（最慢的是读官网首页），40 秒还没回就不等了
      try {
        return await 发<核验回应>("verify", 请求, signal, 40);
      } catch (e) {
        if (signal?.aborted) throw e;
        console.warn("[research] 程序直查没核成：", e instanceof Error ? e.message : e);
        return null;
      }
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
  // 模型名每次调用由编排传（摘要 / 报告两个角色），这里只给一个兜底
  通道.模型调用 = 网关模型(cfg, () => 通道.模型);
  return 通道;
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
  // 登录了云端就走云端：填没填自己的模型 Key 都一样——背调的搜索和分析都用我们的服务、照价扣（10-16 总控定）
  if (云端) return { ok: true, 通道: 云端通道(云端) };
  if (env.NODE_ENV !== "production") return { ok: true, 通道: 模拟通道() };
  return { ok: false, error: 本地模式() ? "背调要联网搜索，请先在桌面端登录账号" : "背调目前只在桌面端可用" };
}
