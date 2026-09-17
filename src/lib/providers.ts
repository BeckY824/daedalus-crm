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
 * 模型列表只放**常用的那几个**，不求全：选单太长和要人自己填一样劝退。
 * 填在这里的都是撰写时各家的主力型号，过时了就在这里改一行。
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
  {
    id: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: [{ id: "glm-4-plus" }, { id: "glm-4-flash", note: "快、便宜" }],
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    keyHint: "在智谱开放平台的用户中心拿",
  },
  {
    id: "moonshot",
    name: "月之暗面 Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [{ id: "moonshot-v1-32k" }, { id: "moonshot-v1-8k", note: "便宜" }],
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    keyHint: "sk-…",
  },
  {
    id: "qwen",
    name: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [{ id: "qwen-plus" }, { id: "qwen-turbo", note: "快、便宜" }],
    keyUrl: "https://bailian.console.aliyun.com/?apiKey=1",
    keyHint: "在阿里云百炼控制台拿",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: [{ id: "gpt-4o-mini", note: "便宜" }, { id: "gpt-4o" }],
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-…（国内直连多半要自备网络）",
  },
];

/** 地址属于哪一家。用来把已存的配置还原成「选了哪一家」 */
export function 认服务商(baseUrl: string | undefined): Provider | undefined {
  if (!baseUrl) return undefined;
  const u = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  return PROVIDERS.find((p) => p.baseUrl.toLowerCase() === u);
}
