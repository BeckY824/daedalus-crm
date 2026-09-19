/**
 * 能一键选的模型服务商。
 *
 * 这份表存在的理由是「别让人填接口地址」。原来 AI 接入那一栏摊开六样东西——
 * 接口地址、API Key、模型名、首页可选模型、拉取模型、测试连接——而其中三样
 * （地址、模型名、可选模型）对 99% 的人来说是同一个答案：他用哪家，那家就那几个值。
 * 选一家、填一个 Key，剩下的这里都知道。
 *
 * **不收本地推理**（Ollama、LM Studio 那类）：这套 CRM 的 AI 是 agent 循环，
 * 要模型稳定地按格式调工具，本地小模型在这件事上失败率高到会让人以为是产品坏了。
 * 真要指到别处的人，「高级」里仍然能自己填地址——那是留给知道自己在做什么的人的。
 *
 * **2026-09-20 起这张表只剩 DeepSeek 一家。**
 *
 * 之前摆着五家（DeepSeek、智谱、Kimi、通义、OpenAI）。摆五家的代价不是多几行代码，
 * 是**每一家的脾气都不一样，而提示词只有一套**：同一段话在 GLM 上是「不查就敢下结论」
 * （库里有一个渠道，它答「还没有登记任何渠道」），在 DeepSeek 上是「爱堆格式」
 * （问一个电话号码先画一张六列的表）。我们只照着一家的毛病调过提示词，
 * 摆着另外四家等于请人去踩没验过的路——而他踩坏了只会认为是这个产品不行。
 *
 * 选一家还有一件事跟着变简单：模型名、默认值、可选清单都只有一个答案。
 *
 * **想用别家的人仍然走得通**：「其它（自己填接口地址）」那一条没动，
 * 填地址、Key、模型名照样能跑——那是留给知道自己在做什么的人的。
 * 已经存过别家配置的库也不会坏：`认服务商` 认不出来就当「其它」，
 * 地址和模型名原样显示在那儿，能看能改。
 */
export type Provider = {
  id: string;
  /** 界面上怎么叫 */
  name: string;
  baseUrl: string;
  /** 第一个是默认 */
  models: { id: string; note?: string }[];
  /** 去哪儿拿 Key */
  keyUrl: string;
  keyHint: string;
};

export const PROVIDERS: Provider[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: [
      { id: "deepseek-chat", note: "便宜、够用" },
      { id: "deepseek-reasoner", note: "会推理，慢一些" },
    ],
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "sk-…",
  },
];

/** 地址属于哪一家。用来把已存的配置还原成「选了哪一家」 */
export function 认服务商(baseUrl: string | undefined): Provider | undefined {
  if (!baseUrl) return undefined;
  const u = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  return PROVIDERS.find((p) => p.baseUrl.toLowerCase() === u);
}
