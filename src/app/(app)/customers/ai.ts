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
import { 字段表, type 字段名 } from "@/lib/import/fields";
import { 问选择, type 选择答案 } from "@/lib/jev/client";
import { 组问题 } from "@/lib/jev/columns";
import { 自动判断开着 } from "@/lib/jev/settings";
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

/**
 * 猜列的兜底：规则认不出来的那几列，问一次判断模型。
 *
 * **和上面那个 `粘成表格` 是两类调用，别按同一套规矩管：**
 *   粘成表格   生成类，用户按了按钮才跑，占 AI 次数，一次几分钱
 *   这一个     判断类，导入到第二步自动跑，不占次数，一次两万分之一美分
 * 分类的理由和那条线（判断类可以自动跑，但输出只许落在界面默认值上）见隐私政策第三节。
 *
 * 发出去的只有**表头**和**前三行样例值**，其余行不发——政策里是这么写的，这里就得是这样。
 *
 * 回的是**原始答案**而不是合并好的映射：合并要拿抽屉里那一刻的映射当底，
 * 因为这一趟往返里人可能已经手动选了某一列——那一列绝不能被后到的结果盖掉
 * （「用户改过的字段不许被同步覆盖」，同一条规矩）。合并在 lib/jev/columns.ts 的 `并进来`。
 *
 * 任何一环出岔子都返回 null：没配 key、关了开关、断网、超时、429。调用方原样保留规则的结果。
 */
export async function 猜列建议(
  表头: string[],
  样例: string[][],
  规则: (字段名 | null)[],
): Promise<Record<string, 选择答案> | null> {
  await requireUser();
  if (!(await 自动判断开着())) return null;

  const 问题 = 组问题(表头, 样例, 规则, 字段表(await getBusiness()));
  if (Object.keys(问题).length === 0) return null;

  return 问选择({ 任务: "把一份客户表格的每一列对应到 CRM 里的字段" }, 问题);
}
