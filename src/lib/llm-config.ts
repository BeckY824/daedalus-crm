/**
 * 用哪把 Key、走哪个接口、默认哪个模型——LLM 的**配置**这一半。怎么发请求在 llm.ts。
 *
 * 配置两级读取：**设置页填的 > 环境变量**。
 *   界面：设置管理 → AI 接入（接口地址 / API Key / 模型名），存在 Setting 表，Key 加密
 *   环境：LLM_API_KEY / LLM_BASE_URL / LLM_MODEL，作为首次初始化与无界面场景的兜底；
 *         桌面端本地模式下是登录的云端账号（lib/desktop/cloud.ts）
 * 两处都没 key → AI 能力整体隐藏，CRM 其余功能不受影响。
 *
 * 加一种模型接入：只要它是 OpenAI 兼容接口，填地址和 Key 就行，不用改代码。
 * 调用方一律从 llm.ts 引（它把这里的导出原样转出去）。
 */
import { getSetting, setSetting, encryptSecret, decryptSecret, maskSecret } from "./settings";
import { 模型配置 as 桌面端云端配置, 本地模式 } from "./desktop/cloud";

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
  // 桌面端只认登录的云端账号：没登录（或登录信息坏了）就是没有，不退到环境变量（那是自部署 / 托管版的配置）
  if (本地模式()) return null;
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
 * 只要「从哪来」，不去云端问余额——describeLlmConfig 在 cloud 那一支要联网等最多 6 秒，
 * 全站布局每次整页加载都要知道「这个人的 AI 计不计次」，等不起。三种来源的含义见下面那段。
 */
export async function 模型来源(): Promise<"ui" | "cloud" | "env" | null> {
  const stored = await getSetting<StoredLlm>(LLM_KEY);
  if (stored?.apiKeyEnc && decryptSecret(stored.apiKeyEnc)) return "ui";
  const env = 环境配置();
  if (env?.account) return "cloud";
  return env ? "env" : null;
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
  /** 每天登录再送几次。老版本服务端不返回，那就不提这句；过了注册后 30 天是 0 */
  每日赠送?: number;
  /** 每日赠送发到哪天（YYYY-MM-DD，含当天）。0.46.6 起才有，老服务端没有 */
  每日赠送截至?: string | null;
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
      每日赠送截至: typeof d.每日赠送截至 === "string" ? d.每日赠送截至 : undefined,
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
