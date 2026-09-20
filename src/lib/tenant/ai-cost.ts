/**
 * 每次模型调用烧了多少 token——**攒成本曲线用的，不是给用户看的**。
 *
 * ## 为什么要有它
 *
 * 在这之前只记了调用**次数**（AiUsage / AccountAiUsage 两个单行计数器）。
 * 而「¥29 / 300 次」这个价目前是照公开价估的，一条真实数据都没有——
 * 我们走的是中转站，公开价根本不是实付价，等于两层猜测。
 *
 * 这份数据的特点是**只能随时间攒，补不回来**：晚一周开始记就少一周曲线。
 * 所以它优先于任何「看起来更要紧」的功能。
 *
 * ## 永不抛
 *
 * 记录**永不抛**，出错只打一行日志——为了记账让用户的提问失败，那是真的错。
 *
 * 但要 **await**，不是甩出去不管：响应一旦返回，挂着的 Promise 可能被直接丢掉，
 * 表现是「偶尔少一条」——而这份数据的全部价值就在于它是连续的。
 * 一次本地 SQLite 插入零点几毫秒，和一次几秒的模型调用比可以忽略。
 *
 * ## 谁记、记谁
 *
 *   桌面端   请求经我们的网关 → **网关**记，owner = 账号
 *   托管版   本进程直接打上游 → **llm.ts** 记，owner = 工作区
 *   自部署   不记。那是人家自己的 key，花的不是我们的钱
 *
 * 两条路不会重叠：托管版不走网关，桌面端的 llm.ts 跑在用户自己机器上、连不到控制面库。
 */
import { control } from "./control";
import { multiTenant } from "./context";
import { currentTenant } from "./context";
import { resolveCurrentTenant } from "./resolve";

export type 归属 = { kind: "account" | "workspace"; id: string };

export type 用量 = { input: number; output: number };

/**
 * 从 OpenAI 兼容的响应体里取用量。
 *
 * 取不到就返回 null：有些中转站不回 `usage`，那时**宁可不记，也不要记 0**——
 * 一堆 0 会把平均值稀释掉，而稀释过的曲线比没有曲线更坏（它看起来是对的）。
 */
export function 读用量(data: unknown): 用量 | null {
  const u = (data as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  if (!u) return null;
  const 入 = typeof u.prompt_tokens === "number" ? u.prompt_tokens : null;
  const 出 = typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
  if (入 === null) return null;
  return { input: 入, output: 出 };
}

/** 记一次。**永不抛。** 调用方不用 await，也不用管成败 */
export async function 记一次(
  归属: 归属,
  入: { model: string; usage: 用量; feature?: string | null },
): Promise<void> {
  try {
    await control.aiCall.create({
      data: {
        ownerKind: 归属.kind,
        ownerId: 归属.id,
        model: 入.model,
        inputTokens: 入.usage.input,
        outputTokens: 入.usage.output,
        feature: 入.feature ?? null,
      },
    });
  } catch (e) {
    console.warn("[ai-cost] 这一次没记上：", e instanceof Error ? e.message : e);
  }
}

/**
 * 托管版这一侧的记录口。**不是托管版就直接跳过**——
 * 桌面端本地模式和自部署的开源版都会走到这里（它们也用 llm.ts），
 * 但前者的账由网关记，后者根本不该记。
 *
 * 拿不到工作区也跳过：没有归属的行没法按人算成本，留着只会让合计虚高。
 */
export async function 记托管版一次(data: unknown, model: string, feature?: string | null): Promise<void> {
  if (!multiTenant()) return;
  const u = 读用量(data);
  if (!u) return;
  try {
    const t = currentTenant() ?? (await resolveCurrentTenant());
    if (!t) return;
    await 记一次({ kind: "workspace", id: t.workspaceId }, { model, usage: u, feature });
  } catch (e) {
    console.warn("[ai-cost] 这一次没记上：", e instanceof Error ? e.message : e);
  }
}

/**
 * 单价（元 / 百万 token）。**默认没有**，不是默认一个估值。
 *
 * 整件事的出发点就是「定价要算出来，不是拍出来」——那这里更不该先拍一个数
 * 再拿它去算，那等于把猜测洗成了「数据」。等账单对上了，把真实数字填进
 * LLM_PRICE_IN / LLM_PRICE_OUT，历史整个能重算（这正是连 model 一起记的理由）。
 * 没配的时候运营台只显示 token，不显示钱。
 */
export function 单价(): { 入: number; 出: number } | null {
  const 入 = Number(process.env.LLM_PRICE_IN);
  const 出 = Number(process.env.LLM_PRICE_OUT);
  if (!Number.isFinite(入) || !Number.isFinite(出) || (入 === 0 && 出 === 0)) return null;
  return { 入, 出 };
}

export type 成本概览 = {
  天数: number;
  合计: { 次数: number; 入: number; 出: number };
  按天: { 日: string; 次数: number; 入: number; 出: number }[];
  按模型: { model: string; 次数: number; 入: number; 出: number }[];
  按归属: { kind: string; id: string; 次数: number; 入: number; 出: number }[];
  单价: { 入: number; 出: number } | null;
};

/**
 * 近 N 天的成本概览，给运营台看。
 *
 * 在内存里聚合而不是写 SQL 分组：SQLite 按本地日历天分组要绕 strftime + 时区，
 * 而这张表眼下一天最多几百行，取回来 reduce 一遍更直白也更好测。
 * 哪天行数上来了再换成 SQL——那时它也该有自己的归档策略了。
 */
export async function 成本概览(天数 = 14): Promise<成本概览> {
  const 起 = new Date();
  起.setDate(起.getDate() - (天数 - 1));
  起.setHours(0, 0, 0, 0);

  const rows = await control.aiCall.findMany({
    where: { at: { gte: 起 } },
    orderBy: { at: "desc" },
    take: 50_000,
    select: { at: true, model: true, inputTokens: true, outputTokens: true, ownerKind: true, ownerId: true },
  });

  const 合计 = { 次数: rows.length, 入: 0, 出: 0 };
  const 天 = new Map<string, { 次数: number; 入: number; 出: number }>();
  const 模 = new Map<string, { 次数: number; 入: number; 出: number }>();
  const 主 = new Map<string, { kind: string; id: string; 次数: number; 入: number; 出: number }>();

  for (const r of rows) {
    合计.入 += r.inputTokens;
    合计.出 += r.outputTokens;
    // 按本地日历天分（生产 TZ=Asia/Shanghai），和运营看报表的口径一致
    const 日 = `${r.at.getFullYear()}-${String(r.at.getMonth() + 1).padStart(2, "0")}-${String(r.at.getDate()).padStart(2, "0")}`;
    for (const [表, 键, 额外] of [
      [天, 日, null],
      [模, r.model || "（未知）", null],
      [主, `${r.ownerKind}:${r.ownerId}`, { kind: r.ownerKind, id: r.ownerId }],
    ] as const) {
      const 桶 = (表 as Map<string, Record<string, unknown>>).get(键) ?? { 次数: 0, 入: 0, 出: 0, ...(额外 ?? {}) };
      桶.次数 = (桶.次数 as number) + 1;
      桶.入 = (桶.入 as number) + r.inputTokens;
      桶.出 = (桶.出 as number) + r.outputTokens;
      (表 as Map<string, Record<string, unknown>>).set(键, 桶);
    }
  }

  return {
    天数,
    合计,
    按天: [...天.entries()].map(([日, v]) => ({ 日, ...v })).sort((a, b) => a.日.localeCompare(b.日)),
    按模型: [...模.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.入 + b.出 - (a.入 + a.出)),
    按归属: [...主.values()].sort((a, b) => b.入 + b.出 - (a.入 + a.出)).slice(0, 10),
    单价: 单价(),
  };
}
