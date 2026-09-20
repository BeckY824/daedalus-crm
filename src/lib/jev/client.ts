/**
 * 判断类模型（Jev）的小客户端。
 *
 * ## 为什么不塞进 lib/llm.ts
 *
 * 那套是 OpenAI 兼容的对话接口，回的是一段文字；这个不是（`POST /v1/systemone`），
 * 回的是「选中哪一项 + 一个概率分布」。两件不同的东西，合在一个抽象里只会互相将就。
 *
 * ## 这一层的全部职责：永远不抛，答不上来就返回 null
 *
 * 调用方拿到 null 一律回落到规则。**规则是默认路径，这玩意儿是增强**——
 * 没配 key、断网、429、超时、哪天这家公司没了，表现完全一样：功能退回它原来的样子，
 * 不是坏掉。所以这里一个 throw 都不往外放。
 *
 * ## 不进 AI 次数账本
 *
 * 那个账本（lib/ai-quota.ts）是给生成类调用记的——一次几分钱、用户主动点。
 * 判断类一次两万分之一美分、而且是自动跑的，记进去等于把额度花在用户看不见的地方。
 * 见隐私政策第三节：这两类是分开讲的。
 */
import { TypeSafeClient, type ChoiceQuestion } from "@typesafe-ai/sdk";

/** 一次判断最多等这么久。超了就当没有——让人多点两下下拉框，好过让导入卡住 */
const 超时毫秒 = 8000;

/** 只重一次。判断类是可有可无的增强，为它把一个界面动作拖成三秒不值 */
const 重试次数 = 1;

let 缓存: TypeSafeClient | null | undefined;

function 取客户端(): TypeSafeClient | null {
  if (缓存 !== undefined) return 缓存;
  const key = process.env.JEV_API_KEY?.trim();
  const base = process.env.JEV_BASE_URL?.trim();
  缓存 = key
    ? new TypeSafeClient({
        apiKey: key,
        // 自建转发时指到别处。桌面端将来走我们的网关也是靠这一项
        ...(base ? { baseURL: base } : {}),
        timeout: 超时毫秒,
        retry: { maxRetries: 重试次数 },
      })
    : null;
  return 缓存;
}

/** 配了 key 吗。界面拿它决定那个开关是不是灰的——没配就没什么可开的 */
export function 判断可用(): boolean {
  return !!process.env.JEV_API_KEY?.trim();
}

/** 一问一答：选中项 + 置信度。SDK 的类型不往外漏，调用方只认这两个数 */
export type 选择答案 = { 选: string; 置信: number };

/**
 * 并行问一组选择题。
 *
 * 一次请求问几十个问题是这个模型的设计（state 只读一遍，问题彼此不串上下文），
 * 所以调用方应该把一整批攒齐了一次问完，而不是循环调用。
 *
 * @returns 问题名 → 答案。任何一环出岔子都返回 null，调用方回落规则
 */
export async function 问选择(
  state: unknown,
  问题: Record<string, ChoiceQuestion>,
): Promise<Record<string, 选择答案> | null> {
  const client = 取客户端();
  if (!client || Object.keys(问题).length === 0) return null;
  try {
    const r = await client.systemOne({ state: state as never, questions: 问题 });
    const out: Record<string, 选择答案> = {};
    for (const [名, a] of Object.entries(r.answers)) {
      if (a.type !== "choice") continue;
      out[名] = { 选: a.choice, 置信: a.confidence };
    }
    return out;
  } catch (e) {
    // 不往外抛，但要留一行——静悄悄地退化最难查
    console.warn("[jev] 判断没拿到，回落规则：", e instanceof Error ? e.message : e);
    return null;
  }
}
