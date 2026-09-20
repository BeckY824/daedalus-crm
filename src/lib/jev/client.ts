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
import { 本地模式, 云端地址, 读 as 读云端凭据 } from "../desktop/cloud";

/** 一次判断最多等这么久。超了就当没有——让人多点两下下拉框，好过让导入卡住 */
const 超时毫秒 = 8000;

/** 只重一次。判断类是可有可无的增强，为它把一个界面动作拖成三秒不值 */
const 重试次数 = 1;

/** 上游地址。网关那条路要用它去转发，所以导出 */
export function JEV上游(): string {
  return (process.env.JEV_BASE_URL?.trim() || "https://api.typesafe.ai").replace(/\/+$/, "");
}

/** 只有这一个模型。网关不听客户端指定——能选模型就等于能选我们的账单 */
export const JEV模型 = "jev-latest";

type 接法 = { apiKey: string; baseURL: string };

/**
 * 这个部署该怎么连上判断模型。两条路，**顺序有讲究**：
 *
 *   1. **本机有 key**（托管版、自部署版里运维自己配的）→ 直连上游。
 *      放在前面是为了让自部署的人能用自己的 key，也让本机联调能指到别处。
 *   2. **桌面端本地模式** → 走我们的网关，拿设备令牌当 key。
 *      用户手上不会有 TypeSafe 的 key，而我们的 key 不能打进安装包——
 *      打进去就能被扒出来，谁拿到谁花我们的钱。和 DeepSeek 那条路同一个道理。
 *
 * 两条都不成立就返回 null，调用方回落规则。
 */
function 接法(): 接法 | null {
  const key = process.env.JEV_API_KEY?.trim();
  if (key) return { apiKey: key, baseURL: JEV上游() };
  if (本地模式()) {
    const 凭据 = 读云端凭据();
    // 没登录云端账号就没有令牌。那时桌面端本来也调不了 AI，行为一致
    if (凭据) return { apiKey: 凭据.token, baseURL: `${(凭据.baseUrl || 云端地址()).replace(/\/+$/, "")}/api/gateway` };
  }
  return null;
}

/** 缓存按「接法」存：桌面端退出再登录会换一把令牌，认着旧的会一直 401 */
let 缓存: { 键: string; c: TypeSafeClient } | null = null;

function 取客户端(): TypeSafeClient | null {
  const 怎么接 = 接法();
  if (!怎么接) return null;
  const 键 = `${怎么接.baseURL}#${怎么接.apiKey}`;
  if (缓存?.键 === 键) return 缓存.c;
  const c = new TypeSafeClient({
    apiKey: 怎么接.apiKey,
    baseURL: 怎么接.baseURL,
    timeout: 超时毫秒,
    retry: { maxRetries: 重试次数 },
  });
  缓存 = { 键, c };
  return c;
}

/**
 * 这个部署连得上判断模型吗。界面拿它决定那个开关摆不摆——
 * 摆一个关了也没区别的开关，只会让人以为自己关掉了什么。
 */
export function 判断可用(): boolean {
  return 接法() !== null;
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
