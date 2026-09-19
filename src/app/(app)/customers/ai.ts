"use server";

/**
 * 「粘任何东西」的那一次模型调用。
 *
 * 整条导入里唯一一处用到 AI 的地方，所以它单独一个文件，不混进 import-actions.ts
 * ——那边三件事都离不开数据库，这边一次网络调用、一行库都不碰。
 *
 * **AI 不自动跑。** 粘进去不会有任何事发生，要人自己按那颗按钮
 * （和记录页「AI 解析」同一条规矩）。理由是这一次调用要花钱、要占次数，
 * 而人粘东西进输入框的动作太便宜了——边想边粘、粘错了重粘都是常事。
 */
import { requireUser } from "@/lib/auth";
import { consumeAiQuota } from "@/lib/ai-quota";
import { recordAiUse } from "@/lib/ai-usage";
import { chatJSON } from "@/lib/llm";
import { getBusiness } from "@/lib/business";
import { 字段表 } from "@/lib/import/fields";
import { 组提示词, 核对, 粘贴字数上限, type 粘贴结果 } from "@/lib/import/paste";

export type 粘贴回执 = ({ ok: true } & 粘贴结果) | { ok: false; error: string };

export async function 粘成表格(原文: string): Promise<粘贴回执> {
  const user = await requireUser();
  const 文 = (原文 ?? "").trim();
  if (!文) return { ok: false, error: "先把名单或聊天记录粘进来" };
  if (文.length > 粘贴字数上限) {
    return { ok: false, error: `一次最多粘 ${粘贴字数上限} 字，这段有 ${文.length} 字。再多请存成 Excel 走文件那条路` };
  }

  const wait = consumeAiQuota(user.id);
  if (wait !== null) return { ok: false, error: `AI 调用太频繁，请 ${wait} 秒后再试` };

  const b = await getBusiness();
  const 建议 = 字段表(b).map((f) => f.label);

  try {
    /*
      两个参数都比别处给得大，各有各的道理：

      maxTokens —— 这次的输出长度跟着输入走（每一格都是原文里的字），
      而别处的 prompt 产出的都是一小段话。给默认那 4000 的话，
      一份七八十人的名单会在中途被截断，回来是一段不合法的 JSON。

      timeoutMs —— 同理，几十行的表比一条微信草稿慢得多。默认那 60 秒
      是按「别让销售干等」定的，但这一次人是按了按钮在等一张表，
      等到一半被判超时、次数还照扣，比多等一分钟难受。
    */
    const raw = await chatJSON(组提示词(文, 建议, b.customer), { maxTokens: 8000, timeoutMs: 120_000 });
    const 结果 = 核对(raw, 文);
    if (结果.数据.length === 0) {
      return { ok: false, error: "没能从这段文本里读出人来。至少要有姓名和手机号" };
    }
    await recordAiUse(user, "paste", `AI 把粘贴的文本整理成 ${结果.数据.length} 行`);
    return { ok: true, ...结果 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "整理失败，请稍后重试" };
  }
}
