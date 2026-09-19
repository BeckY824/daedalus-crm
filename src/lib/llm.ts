/**
 * LLM 调用层 —— 任何 OpenAI 兼容接口（DeepSeek 官方、OpenAI、中转站、本地 Ollama…）。
 *
 * 配置两级读取：**设置页填的 > 环境变量**。
 *   界面：设置管理 → AI 接入（接口地址 / API Key / 模型名），存在 Setting 表，Key 加密
 *   环境：LLM_API_KEY / LLM_BASE_URL / LLM_MODEL，作为首次初始化与无界面场景的兜底
 * 两处都没 key → AI 能力整体隐藏，CRM 其余功能不受影响。
 *
 * 几条用真实回归换来的规矩：
 *   1. 显式传 max_tokens 与超时——不传时实际上限取决于网关自己的默认值，
 *      不透明也不一致，"输出被截断"和"模型没遵循格式"两种失败会混在一起
 *   2. response_format=json_object 失败时降级为普通调用（部分网关不支持该参数）
 *   3. 返回内容先剥代码围栏再解析；仍不是合法 JSON 时带着原始输出重试一次
 *
 * 只在 Server Action / 服务端调用，key 不会下发到浏览器。
 */
import { getSetting, setSetting, encryptSecret, decryptSecret, maskSecret } from "./settings";
import { getBusiness } from "./business";
import { 模型配置 as 桌面端云端配置 } from "./desktop/cloud";

export const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
export const DEFAULT_MODEL = "deepseek-chat";

export type LlmConfig = { apiKey: string; baseUrl: string; model: string };

/** 首页模型选单里的一项。note 是管理员写的一句话，比如「限时免费」「贵，别常用」 */
export type ModelOption = { id: string; note?: string };

const LLM_KEY = "llm";
type StoredLlm = { baseUrl?: string; model?: string; apiKeyEnc?: string; options?: ModelOption[] };

const normBase = (u: string | undefined) => (u && u.trim() ? u.trim().replace(/\/+$/, "") : DEFAULT_BASE_URL);

/**
 * 环境这一级的配置：来自 .env（自部署、托管版），或桌面端登录的云端账号。
 *
 * 桌面端那份**每次都重读文件**（lib/desktop/cloud.ts）：登录、退出要即时生效。
 * 2026-09-17 之前它也是走环境变量的，由 Electron 在起本地服务时塞进去——
 * 代价是登录退出都得重启本地服务，而且账号那一半只能活在壳里。
 * 非本地模式下 桌面端云端配置() 永远是 null，托管版和自部署版一行都不受影响。
 */
function 环境配置(): { apiKey: string; baseUrl: string; model: string; account?: string; models: string[] } | null {
  const 云端 = 桌面端云端配置();
  if (云端) {
    return {
      apiKey: 云端.apiKey,
      baseUrl: 云端.baseUrl,
      model: 云端.models[0]?.split("|")[0]?.trim() || DEFAULT_MODEL,
      account: 云端.account,
      models: 云端.models,
    };
  }
  if (!process.env.LLM_API_KEY) return null;
  return {
    apiKey: process.env.LLM_API_KEY,
    baseUrl: normBase(process.env.LLM_BASE_URL),
    model: process.env.LLM_MODEL?.trim() || DEFAULT_MODEL,
    account: process.env.CLOUD_ACCOUNT || undefined,
    models: (process.env.LLM_MODELS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
  };
}

/** 当前生效的配置；null 表示 AI 未启用 */
export async function getLlmConfig(): Promise<LlmConfig | null> {
  const stored = await getSetting<StoredLlm>(LLM_KEY);
  if (stored?.apiKeyEnc) {
    const apiKey = decryptSecret(stored.apiKeyEnc);
    // 解不出来（AUTH_SECRET 换了）就当没配，落到环境变量
    if (apiKey) return { apiKey, baseUrl: normBase(stored.baseUrl), model: stored.model?.trim() || DEFAULT_MODEL };
  }
  const env = 环境配置();
  if (env) return { apiKey: env.apiKey, baseUrl: env.baseUrl, model: env.model };
  return null;
}

/** AI 能力是否可用。页面用它决定是否渲染 AI 入口 */
export async function llmEnabled(): Promise<boolean> {
  return (await getLlmConfig()) !== null;
}

/**
 * 给设置页看的状态：**不含明文 key**，只回显尾 4 位。
 *
 * 三种来源，界面上要说三种不同的话：
 *   ui    —— 用户自己在设置里填的（密文存在本机库里，见 lib/settings.ts）
 *   cloud —— 桌面端登录了云端账号，那枚设备令牌被当作 Key 用。这时要显示是哪个账号、
 *            还剩几次免费——不显示的话用户只能靠菜单里一个不起眼的入口去查
 *   env   —— 运维在 .env 里配的（自部署、托管版）
 */
export async function describeLlmConfig(): Promise<{
  source: "ui" | "cloud" | "env" | null;
  baseUrl: string;
  model: string;
  keyMasked: string | null;
  options: ModelOption[];
  /** source=cloud 时：登录的是哪个账号 */
  account?: string;
  /** source=cloud 时：免费次数。问不到（断网、服务端没开网关）就是 null */
  credits?: 云端余额 | null;
}> {
  const stored = await getSetting<StoredLlm>(LLM_KEY);
  const options = stored?.options ?? [];
  const uiKey = stored?.apiKeyEnc ? decryptSecret(stored.apiKeyEnc) : null;
  if (uiKey) {
    return { source: "ui", baseUrl: normBase(stored?.baseUrl), model: stored?.model?.trim() || DEFAULT_MODEL, keyMasked: maskSecret(uiKey), options };
  }
  const env = 环境配置();
  if (env?.account) {
    return {
      source: "cloud",
      account: env.account,
      credits: await 问云端余额(env),
      baseUrl: env.baseUrl,
      model: env.model,
      keyMasked: maskSecret(env.apiKey),
      options,
    };
  }
  if (env) {
    return { source: "env", baseUrl: env.baseUrl, model: env.model, keyMasked: maskSecret(env.apiKey), options };
  }
  return { source: null, baseUrl: stored?.baseUrl?.trim() || DEFAULT_BASE_URL, model: stored?.model?.trim() || DEFAULT_MODEL, keyMasked: null, options };
}

/**
 * 上游的报错原文会同时去两个地方：浏览器（设置页的「测试连接」、AI 对话的错误提示）
 * 和日志（桌面端连 stdout 一起写进日志文件）。而有些中转站鉴权失败时会把
 * 收到的 Key 回显在错误体里——那一刻「Key 不进日志、不回浏览器」两条承诺一起破。
 * 拼进 Error 之前先抹掉。
 */
function 抹掉密钥(text: string, key: string): string {
  if (!key || key.length < 8) return text;
  return text.split(key).join("****");
}

/**
 * 问一次云端还剩几次免费。
 *
 * 只在设置页打开时问，不缓存也不重试：问不到就显示「查不到」，
 * 让一个「看一眼余额」的动作把设置页卡住是本末倒置。超时给 6 秒——
 * 断网时它要在页面渲染前就放弃。
 */
export type 云端余额 = {
  上限: number;
  用掉: number;
  还剩: number;
  /** 每天登录再送几次。老版本服务端不返回，那就不提这句 */
  每日赠送?: number;
  /** 注册赠送是多少次。用来把「注册页说的」和「你实际有的」对上 */
  注册赠送?: number;
  /**
   * 注册赠送那一份发出去了没有。**false 才需要解释**——
   * 这台电脑上已经有别的账号领过了（一台机器只送一次）。
   * 老版本服务端不返回这个字段，此时是 undefined：不知道就什么都不说，别猜。
   */
  注册赠送已发?: boolean;
};

async function 问云端余额(env: { apiKey: string; baseUrl: string }): Promise<云端余额 | null> {
  const base = env.baseUrl.replace(/\/+$/, "");
  const key = env.apiKey;
  if (!base || !key) return null;
  try {
    const res = await fetch(`${base}/credits`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as Partial<云端余额>;
    if (typeof d.还剩 !== "number") return null;
    return {
      上限: d.上限 ?? 0,
      用掉: d.用掉 ?? 0,
      还剩: d.还剩,
      每日赠送: typeof d.每日赠送 === "number" ? d.每日赠送 : undefined,
      注册赠送: typeof d.注册赠送 === "number" ? d.注册赠送 : undefined,
      注册赠送已发: typeof d.注册赠送已发 === "boolean" ? d.注册赠送已发 : undefined,
    };
  } catch {
    // 断网、服务端没开网关、老版本服务端——都按「查不到」处理
    return null;
  }
}

/**
 * 首页选单里能选的模型。
 *
 * 为什么要有白名单：浏览器会把选中的模型名发上来，直接透传等于让任何登录用户
 * 点名调用任意模型（贵的、没权限的）。所以一律按这张单子校验，不在单子里就用默认的。
 * 单子空着时只有默认模型一项——不配置就等于没有选单，和以前一样。
 */
export async function listModelOptions(): Promise<ModelOption[]> {
  const cfg = await getLlmConfig();
  if (!cfg) return [];
  const stored = await getSetting<StoredLlm>(LLM_KEY);

  /*
    **用户填了自己的 Key，就只留他填的那一个模型。**

    2026-09-19 报上来的。`saveLlmConfig` 里那句
    `options: input.options ?? stored.options ?? []` 会把**上一次云端账号的型号表留着**，
    于是一个填了自己 Key 的人，选单里仍然列着中转站那几个型号——
    而那些型号在他自己的接口上根本不存在，选中一个就是一次必然失败的请求。
    更别说 `resolveModel` 就是拿这张单子放行的，等于放行了一串注定 404 的名字。

    他填的那个是他唯一验证过的（「测试连接」过的就是它），所以只留它。
    要多几个的人，路是「高级」里自己填 `options`——那是留给知道自己在做什么的人的。
  */
  if (stored?.apiKeyEnc && decryptSecret(stored.apiKeyEnc)) return [{ id: cfg.model }];

  const fromEnv = (环境配置()?.models ?? [])
    .map((x) => {
      const [id, ...note] = x.split("|");
      return { id: id.trim(), note: note.join("|").trim() || undefined };
    });
  const list = (stored?.options?.length ? stored.options : fromEnv).filter((o) => o.id);
  // 当前默认模型永远在单子里，且排第一——否则人会看到一个自己正在用却选不回来的模型
  const rest = list.filter((o) => o.id !== cfg.model);
  const head = list.find((o) => o.id === cfg.model) ?? { id: cfg.model };
  return [head, ...rest];
}

/** 把浏览器送上来的模型名收成一个可用的模型名 */
export async function resolveModel(requested: string | undefined): Promise<string | undefined> {
  if (!requested) return undefined;
  const allowed = await listModelOptions();
  return allowed.some((o) => o.id === requested) ? requested : undefined;
}

/** 设置页「拉取可用模型」：问接口它支持哪些（OpenAI 兼容的 /models） */
export async function fetchRemoteModels(input: { baseUrl: string; apiKey?: string | null }): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const cfg = await resolveLlmConfigForTest({ baseUrl: input.baseUrl, model: "", apiKey: input.apiKey });
  if (!cfg) return { ok: false, error: "还没填 API Key" };
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, error: `接口返回 ${res.status}` };
    const data = (await res.json()) as { data?: { id?: string }[] };
    const models = (data.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
    if (!models.length) return { ok: false, error: "接口没返回任何模型，手动填模型名吧" };
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === "TimeoutError" ? "拉取超时" : "拉不到模型列表，手动填模型名吧" };
  }
}

/**
 * 保存界面配置。apiKey 传空表示"不改 key"，只更新地址与模型——
 * 界面上 key 只回显尾 4 位，用户改个模型名不该被迫重新粘一遍 key。
 */
export async function saveLlmConfig(input: { baseUrl: string; model: string; apiKey?: string | null; options?: ModelOption[] }): Promise<void> {
  const stored = (await getSetting<StoredLlm>(LLM_KEY)) ?? {};
  const next: StoredLlm = {
    baseUrl: normBase(input.baseUrl),
    model: input.model.trim() || DEFAULT_MODEL,
    apiKeyEnc: input.apiKey && input.apiKey.trim() ? encryptSecret(input.apiKey.trim()) : stored.apiKeyEnc,
    options: (input.options ?? stored.options ?? []).map((o) => ({ id: o.id.trim(), note: o.note?.trim() || undefined })).filter((o) => o.id).slice(0, 20),
  };
  await setSetting(LLM_KEY, next);
}

/** 清掉界面配置，回到环境变量（或未启用） */
export async function clearLlmConfig(): Promise<void> {
  await setSetting(LLM_KEY, {});
}

/**
 * 设置页「测试连接」用：填了新 key 就用新的，没填就用已存的。
 *
 * **环境变量里那把 Key 只肯发给环境变量里配的那个地址。**
 * 它和界面上存的那把性质不同：界面那把是这个工作区自己填的，发到哪儿是他自己的事；
 * 环境那把在托管版是全平台共用的，而这个接口的 baseUrl 完全由调用方给——
 * 不限的话，「测试连接」就是一个把平台 Key 送到任意地址的口子
 * （顺带还是一个从服务端发任意 http 请求的口子）。
 * 地址对不上时按「没有 Key」处理，界面会提示先填一个，那条路是安全的。
 */
export async function resolveLlmConfigForTest(input: { baseUrl: string; model: string; apiKey?: string | null }): Promise<LlmConfig | null> {
  const 目标 = normBase(input.baseUrl);
  let apiKey = input.apiKey?.trim() || null;
  if (!apiKey) {
    /**
     * **已经存着的那把 Key，也只肯发给它自己那个地址。**
     *
     * 原来这道闸只加在环境变量那把上，界面存的那把是裸的——于是「测试连接」
     * 和「拉取模型列表」就是一个口子：地址随便填，我们照样把库里那把明文 Key
     * 当 Authorization 发过去。同工作区的第二个管理员、或者拿到管理员会话的人，
     * 都能把明文捞出来，而填 Key 的人以为「填进去就只剩尾 4 位了」。
     *
     * 换地址的正常做法是重填一次 Key——那本来就该重填，因为换了一家服务商。
     */
    const stored = await getSetting<StoredLlm>(LLM_KEY);
    const 存的地址 = normBase(stored?.baseUrl);
    if (stored?.apiKeyEnc && 目标 === 存的地址) apiKey = decryptSecret(stored.apiKeyEnc);
    // normBase 在没配 LLM_BASE_URL 时会回落到默认地址，所以只配了 Key 的自部署也对得上
    const env = 环境配置();
    if (!apiKey && env && 目标 === env.baseUrl) apiKey = env.apiKey;
  }
  if (!apiKey) return null;
  return { apiKey, baseUrl: 目标, model: input.model.trim() || DEFAULT_MODEL };
}


export function stripCodeFence(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    const lines = t.split("\n").slice(1);
    if (lines.length && lines[lines.length - 1].trim().startsWith("```")) lines.pop();
    t = lines.join("\n");
  }
  return t.trim();
}

/** 系统提示词：业务简介来自设置页，改一段话所有 AI 功能一起换语境 */
export function buildSystemPrompt(brief: string): string {
  return (
    "你是 CRM 系统的录入与分析助手，服务一个销售团队。他们的业务：" + brief + "\n" +
    "严格依据用户提供的信息作答，禁止编造事实。" +
    "必须只输出用户要求的 JSON，不要输出任何 JSON 之外的文字、解释或 Markdown 代码块标记。"
  );
}

type ChatOpts = {
  /**
   * 推理模型（如 deepseek-v4-flash）的 max_tokens 会先被思维链（reasoning_content）
   * 消耗，给小了正文直接为空（finish_reason=length）——真实踩坑：给 200 时
   * 371 字符的思维链就把预算吃光了。默认给足，别按"预期输出长度"来省。
   */
  maxTokens?: number;
  temperature?: number;
  /** 默认 60 秒。CRM 的 prompt 都不大，卡住时要快速失败而不是让销售干等 */
  timeoutMs?: number;
  /** 上游取消（用户按 Esc）时中断请求 */
  signal?: AbortSignal;
  /** 这次调用改用哪个模型。必须是 resolveModel 校验过的名字 */
  model?: string;
  /**
   * false = 关掉推理模型的思维链（DeepSeek 的 thinking 参数）。
   * agent 的每步决策只是选工具、填参数，让它"想"一分钟是浪费：真实测过同一段
   * 上下文开着思维链 24~73 秒、关掉 3 秒。最终回答仍开着，质量要紧。
   * 网关不认这个参数时会 4xx，调用方降级重试时去掉它。
   */
  thinking?: false;
};

const DEFAULT_MAX_TOKENS = 4000;

/**
 * 下面两张表记的都是「试探出来的模型行为」。
 *
 * **键是「接口地址 + 模型名」，不是光模型名。**
 * 这两张表是进程级的，而托管版一个进程伺候所有工作区。只按模型名记的话，
 * A 工作区对着自己的中转站试出来的结论，会套到 B 工作区头上——而同一个
 * 「deepseek-chat」在两家中转站上的行为完全可能不一样（一家能关思维链、
 * 一家不能）。那样 B 要么白发一个会被 400 的参数，要么被多扣 2500 的预算。
 *
 * 反过来，**同一个接口地址 + 同一个模型就该共享**：那本来就是同一个上游，
 * 试探一次的结论对谁都成立，这正是这层缓存存在的理由。所以不按工作区分，
 * 按上游分——这才是这件事真正的归属。
 */
function 上游键(cfg: LlmConfig, model: string): string {
  return `${cfg.baseUrl}|${model}`;
}

/**
 * 记住哪些模型不认 thinking 参数。
 *
 * 中转站上的推理模型分两类：一类可以 {"type":"disabled"} 关掉思维链，另一类
 * 「始终思考」，带上这个参数直接 400。光靠调用方 catch 后重试是不够的——
 *   1. agent 循环最多 6 步，每步都要先失败一次再重试，一个问题白跑 6 个往返
 *   2. 更糟的是 chatMessagesJSON 里「模型没输出合法 JSON」那条恢复路径，
 *      它用的还是原始 opts，等于把刚刚失败的参数又加回去，于是 400 冒到界面上
 * 所以把结论记在这里：某个上游的某个模型拒绝过一次，之后就不再给它带这个参数。
 * 进程内缓存，重启后重新试探一次，代价是一个请求。
 */
const 不认thinking = new Set<string>();

/**
 * 见过思维链的模型。
 *
 * max_tokens 是「思考 + 正文」共用的预算，不是正文的预算。实测一个只要求输出
 * {"ok":true} 的请求就烧掉 92 个 reasoning token——给 100 的额度时
 * finish_reason 直接是 length，正文被截断，JSON.parse 失败，
 * 界面上显示「AI 返回内容不是合法 JSON：」后面空空如也，查不出原因。
 *
 * 所以对这类模型额外加一笔思考预算。调用方给的 maxTokens 是它对**正文**的预期，
 * 这个语义不该因为换了个会思考的模型就变味。
 */
const 思考模型 = new Set<string>();
const 思考预算 = 2500;

/** 测试用：把试探出来的结论清掉，让下一次重新试 */
export function 重置模型探测() {
  不认thinking.clear();
  思考模型.clear();
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * 原生 function calling 用的消息。比 ChatMessage 多两种形状：
 *   assistant 带 tool_calls —— 模型说「我要调这几个工具」
 *   role: "tool"           —— 我们把那次调用的结果交回去（靠 tool_call_id 对上）
 */
export type ToolMessage =
  | ChatMessage
  | { role: "assistant"; content: string | null; tool_calls: 工具调用[] }
  | { role: "tool"; content: string; tool_call_id: string };

export type 工具调用 = { id: string; type: "function"; function: { name: string; arguments: string } };
export type 工具声明 = { type: "function"; function: { name: string; description: string; parameters: unknown } };

async function chatRaw(cfg: LlmConfig, messages: ToolMessage[], opts: ChatOpts, useJsonFormat: boolean, stream: boolean, tools?: 工具声明[]): Promise<Response> {
  const 模型 = opts.model ?? cfg.model;
  const 键 = 上游键(cfg, 模型);
  const body: Record<string, unknown> = {
    model: 模型,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: (opts.maxTokens ?? DEFAULT_MAX_TOKENS) + (思考模型.has(键) ? 思考预算 : 0),
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  // 带着 tools 时不能再要 json_object：两个一起发，多数网关会二选一地忽略掉其中一个
  if (useJsonFormat && !tools?.length) body.response_format = { type: "json_object" };
  if (opts.thinking === false && !不认thinking.has(键)) body.thinking = { type: "disabled" };
  if (stream) body.stream = true;
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 60_000)]) : AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (!res.ok) {
    const errText = 抹掉密钥((await res.text()).slice(0, 300), cfg.apiKey);
    // 带了 thinking 又被 4xx 拒：记下这个模型，后面所有调用都不再带，
    // 包括本次调用方马上要做的那次重试
    if (body.thinking && (res.status === 400 || res.status === 422)) {
      不认thinking.add(键);
      console.warn(`[llm] 模型 ${模型} 在 ${cfg.baseUrl} 上不支持关闭思考，后续不再发送该参数`);
    }
    throw new Error(`接口返回 ${res.status}：${errText}`);
  }
  return res;
}

async function chatOnce(cfg: LlmConfig, system: string, prompt: string, opts: ChatOpts, useJsonFormat: boolean): Promise<string> {
  return chatMessagesOnce(cfg, [{ role: "system", content: system }, { role: "user", content: prompt }], opts, useJsonFormat);
}

async function chatMessagesOnce(cfg: LlmConfig, messages: ToolMessage[], opts: ChatOpts, useJsonFormat: boolean): Promise<string> {
  const res = await chatRaw(cfg, messages, opts, useJsonFormat, false);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
  };
  const model = opts.model ?? cfg.model;
  const 键 = 上游键(cfg, model);

  // 这个上游的这个模型会思考：记下来，之后给它的预算都加上思考那一笔
  if ((data.usage?.completion_tokens_details?.reasoning_tokens ?? 0) > 0 && !思考模型.has(键)) {
    思考模型.add(键);
    console.warn(`[llm] 模型 ${model} 在 ${cfg.baseUrl} 上会输出思维链，后续 max_tokens 额外加 ${思考预算}`);
  }

  const choice = data.choices?.[0];
  const content = (choice?.message?.content ?? "").trim();

  /**
   * 被 max_tokens 截断。必须在这里就炸出来，不能把半截内容交给 JSON.parse：
   * 那样报的是「返回内容不是合法 JSON」，把「额度不够」说成「模型不听话」，
   * 方向完全错，线上排查会绕很久。调用方接住之后重试，那时预算已经加上去了。
   */
  if (choice?.finish_reason === "length") {
    throw new Error(`AI 回答被长度限制截断（模型 ${model}），已提高预算，请重试`);
  }
  return content;
}

/**
 * 多轮对话版的 JSON 调用：给 agent 循环用（system + 历史 + 工具结果）。
 * 同样带「不支持 json_object 就降级」和「坏 JSON 重试一次」两道保险。
 */
export async function chatMessagesJSON(messages: ToolMessage[], opts: ChatOpts = {}): Promise<unknown> {
  const cfg = await getLlmConfig();
  if (!cfg) throw new Error("AI 功能未启用：请管理员到「设置管理 → AI 接入」填写接口地址与 API Key");
  let content: string;
  try {
    content = await chatMessagesOnce(cfg, messages, opts, true);
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw e.name === "AbortError" ? e : new Error("AI 响应超时，请稍后重试");
    // 网关不认 response_format / thinking 时是 4xx：两个都去掉再试一次
    console.warn(`[llm] JSON 调用失败，降级重试：${e instanceof Error ? e.message.slice(0, 160) : e}`);
    content = await chatMessagesOnce(cfg, messages, { ...opts, thinking: undefined }, false);
  }
  try {
    return JSON.parse(stripCodeFence(content));
  } catch {
    const retry = await chatMessagesOnce(cfg, [...messages, { role: "assistant", content }, { role: "user", content: "你上一次的输出不是合法 JSON，请只输出严格合法的 JSON。" }], opts, true).catch(() =>
      chatMessagesOnce(cfg, messages, opts, false),
    );
    try {
      return JSON.parse(stripCodeFence(retry));
    } catch {
      throw new Error(`AI 返回内容不是合法 JSON：${retry.slice(0, 200)}`);
    }
  }
}

/**
 * 一轮**原生 function calling**。
 *
 * 和 chatMessagesJSON 的区别：那边是我们规定一套 JSON 格式、求模型照着填；
 * 这边把工具表按 OpenAI 的 `tools` 字段发过去，模型走的是它自己训练过的那条路。
 * 小模型在这件事上的差距很大——JSON 协议下它要同时记住「格式」和「选哪个工具」，
 * 原生这条只剩后者。
 *
 * 网关或模型不支持时抛错，由调用方退回 JSON 协议那条路（run.ts 里做的）。
 */
export async function chatTools(
  messages: ToolMessage[],
  tools: 工具声明[],
  opts: ChatOpts = {},
): Promise<{ toolCalls: 工具调用[]; text: string }> {
  const cfg = await getLlmConfig();
  if (!cfg) throw new Error("AI 功能未启用：请管理员到「设置管理 → AI 接入」填写接口地址与 API Key");
  const res = await chatRaw(cfg, messages, opts, false, false, tools);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: 工具调用[] }; finish_reason?: string }[];
  };
  const m = data.choices?.[0]?.message;
  return { toolCalls: m?.tool_calls ?? [], text: (m?.content ?? "").trim() };
}

/**
 * 流式文本：逐 token 回调，给最终回答用——人看到字一个个出来，而不是等十几秒砸出一整块。
 * 网关不支持 stream 时（响应不是事件流）退化为一次性返回。
 */
export async function chatTextStream(messages: ToolMessage[], opts: ChatOpts, onToken: (text: string) => void): Promise<string> {
  const cfg = await getLlmConfig();
  if (!cfg) throw new Error("AI 功能未启用");
  const res = await chatRaw(cfg, messages, opts, false, true);
  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("text/event-stream") || !res.body) {
    const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
    const text = (data?.choices?.[0]?.message?.content ?? "").trim();
    if (text) onToken(text);
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const t = j.choices?.[0]?.delta?.content;
        if (t) {
          full += t;
          onToken(t);
        }
      } catch {
        /* 半截 JSON，等下一段 */
      }
    }
  }
  return full.trim();
}

/**
 * 测试连接：发一次最小请求，回显耗时与模型原话。填错地址、key、模型名当场就知道。
 */
export async function testLlm(cfg: LlmConfig): Promise<{ ok: true; ms: number; reply: string } | { ok: false; error: string }> {
  const t0 = Date.now();
  try {
    const reply = await chatOnce(
      cfg,
      "你是连通性测试的应答方。",
      "请只回复两个字：连接正常",
      { maxTokens: 200, timeoutMs: 20_000 },
      false,
    );
    return { ok: true, ms: Date.now() - t0, reply: reply.slice(0, 100) || "（空回复）" };
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") return { ok: false, error: "20 秒内没有响应：检查接口地址是否可达" };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 调用模型并要求返回 JSON，返回已 parse 的对象。
 * 抛出的 Error 带中文信息，可直接展示给使用者。
 */
export async function chatJSON(prompt: string, opts: ChatOpts = {}): Promise<unknown> {
  const cfg = await getLlmConfig();
  if (!cfg) {
    throw new Error("AI 功能未启用：请管理员到「设置管理 → AI 接入」填写接口地址与 API Key");
  }
  const system = buildSystemPrompt((await getBusiness()).brief);

  let content: string;
  try {
    content = await chatOnce(cfg, system, prompt, opts, true);
  } catch (e) {
    // 网关不支持 response_format 时表现为 4xx，降级为普通调用再试一次；
    // 网络/超时类错误也顺带走这条兜底（多花一次调用，换少一类需要人排查的失败）
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new Error("AI 响应超时，请稍后重试");
    }
    content = await chatOnce(cfg, system, prompt, opts, false);
  }

  const cleaned = stripCodeFence(content);
  try {
    return JSON.parse(cleaned);
  } catch {
    // 带着上次的坏输出重试一次，让模型自己修
    const repairPrompt =
      `${prompt}\n\n【注意】你上一次的输出不是合法 JSON：\n${content.slice(0, 500)}\n` +
      "请只输出严格合法的 JSON，不要输出任何其他文字。";
    const retried = stripCodeFence(
      await chatOnce(cfg, system, repairPrompt, opts, true).catch(() => chatOnce(cfg, system, repairPrompt, opts, false)),
    );
    try {
      return JSON.parse(retried);
    } catch {
      throw new Error(`AI 返回内容不是合法 JSON：${retried.slice(0, 200)}`);
    }
  }
}
