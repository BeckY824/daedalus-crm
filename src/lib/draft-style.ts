/**
 * 起草话术时的「语言」和「语气」（2026-10-02，客户页 AI 栏输入框底下那两枚芯片）。
 *
 * 外贸用户的客户大多不说中文，原来起草出来一律是中文微信，还得自己再翻一遍。
 * 默认「自动」：看跟进记录里对方用什么语言就用什么，没记录用中文。
 *
 * 服务端只认这里列出来的值——Server Action 谁都能直接调，传进来的字符串不能原样拼进提示词。
 */
export const 起草语言们 = ["自动", "中文", "English"] as const;
export const 起草语气们 = ["随和", "正式"] as const;
export type 起草语言 = (typeof 起草语言们)[number];
export type 起草语气 = (typeof 起草语气们)[number];
export type 起草风格 = { 语言?: 起草语言; 语气?: 起草语气 };

export function 规整风格(s: unknown): Required<起草风格> {
  const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
  const 语言 = 起草语言们.includes(o.语言 as 起草语言) ? (o.语言 as 起草语言) : "自动";
  const 语气 = 起草语气们.includes(o.语气 as 起草语气) ? (o.语气 as 起草语气) : "随和";
  return { 语言, 语气 };
}

/** 拼进提示词「要求：」后面的那几条：长度、语言、语气 */
export function 风格要求(s: unknown): string {
  const { 语言, 语气 } = 规整风格(s);
  const 语言句 =
    语言 === "English"
      ? "用英文写，80 词以内"
      : 语言 === "中文"
        ? "用中文写，120 字以内"
        : "用对方在跟进记录里用的语言写（看原文；记录里没有外文就用中文），中文 120 字以内、外文 80 词以内";
  const 语气句 = 语气 === "正式" ? "语气正式、有礼，像商务往来" : "语气随和自然，像熟人之间";
  return `${语言句}；${语气句}`;
}

/** 起草结果的长度上限：外文按词算，字符数比中文长得多，截短了会把话截在半句 */
export const 话术上限 = 800;
