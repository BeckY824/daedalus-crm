/**
 * 飞书 / 钉钉适配器共用的联网小件：fetch、等待、时钟都能换（契约测试换成录好的响应，不联网、不真等）。
 */

export type 联网 = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  等: (ms: number) => Promise<void>;
  现在: () => number;
};

export const 真联网: 联网 = {
  fetch: (url, init) => fetch(url, init),
  等: (ms) => new Promise((r) => setTimeout(r, ms)),
  现在: () => Date.now(),
};

/** 原系统接口报错（权限不够、参数不对、对方出错）。同步里算「出错」，起点不挪，下次再拉 */
export class 接口出错 extends Error {
  /** 对方返回的错误码（有的话）：测试连接按它说原因 */
  constructor(message: string, public code?: number) {
    super(message);
  }
}

/** 被限流时最多重试几次、每次等多久（1s、2s、4s…，封顶 30s） */
export const 最多重试 = 5;
export const 退避 = (第几次: number) => Math.min(30_000, 1000 * 2 ** 第几次);
/** 对方服务器出错（502 网关、503 维护中…）：多半是一时的，和连不上一样再试 连不上重试 次 */
export const 对方出错 = (status: number) => status >= 500 && status <= 599;

/** 单次请求最多等多久：断网时 fetch 会自己报错，但对方不回话（半开连接、网关卡住）时会一直挂着，定时同步就整个卡死 */
export const 请求超时毫秒 = 30_000;
/** 连不上（断网、DNS 解析不了、连接被重置、超时）时再试几次，退避同限流 */
export const 连不上重试 = 2;
/** 一个请求最坏要多久：每次都等满超时、中间退避两回（30 × 3 + 1 + 2 = 93 秒）。界面「正在同步」按这个说 */
export const 单个请求最长毫秒 = 请求超时毫秒 * (连不上重试 + 1) + Array.from({ length: 连不上重试 }, (_, i) => 退避(i)).reduce((a, b) => a + b, 0);

function 连不上原因(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return `等了 ${请求超时毫秒 / 1000} 秒没响应`;
  const 码 = err?.cause?.code;
  if (码 === "ENOTFOUND" || 码 === "EAI_AGAIN") return "域名解析不了（服务器可能断网了）";
  if (码 === "ECONNREFUSED") return "对方拒绝连接";
  if (码 === "ECONNRESET" || 码 === "UND_ERR_SOCKET") return "连接被断开";
  if (码 === "ETIMEDOUT" || 码 === "UND_ERR_CONNECT_TIMEOUT") return "连接超时";
  return err?.message || String(e);
}

/**
 * 发一次请求：带超时；连不上的重试 连不上重试 次，还不行抛 接口出错「连不上飞书 / 钉钉」。
 * 同步里接口出错 = 这次算出错、起点不挪，下次从同一个时间再拉；拉到一半断的，前面拉到的也不写（还没到写那步）。
 */
export async function 请求(网: 联网, 谁: string, url: string, init: RequestInit): Promise<Response> {
  for (let 第几次 = 0; ; 第几次++) {
    try {
      return await 网.fetch(url, { ...init, signal: AbortSignal.timeout(请求超时毫秒) });
    } catch (e) {
      if (第几次 >= 连不上重试) throw new 接口出错(`连不上${谁}（断网或对方一直没响应，重试了 ${连不上重试} 次）：${连不上原因(e)}`);
      await 网.等(退避(第几次));
    }
  }
}

/** 毫秒时间戳 → 北京时间「2026-10-24 09:30」；整点零分的只给日期 */
export function 北京时间串(ms: number): string {
  const d = new Date(ms + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const 日 = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const 时 = d.getUTCHours();
  const 分 = d.getUTCMinutes();
  return 时 === 0 && 分 === 0 ? 日 : `${日} ${p(时)}:${p(分)}`;
}

/**
 * 读返回内容。不是 JSON 的给 null（调用方按「没有返回内容」报）；
 * 响应头到了、内容读到一半超时 / 断开的，和连不上一样抛 接口出错——不能当成「对方回了空」
 */
export async function 读JSON(res: Response, 谁 = "原系统", 超时毫秒 = 请求超时毫秒): Promise<Record<string, unknown> | null> {
  let 文本: string;
  try {
    文本 = await 读完(res, 谁, 超时毫秒);
  } catch (e) {
    if (e instanceof 接口出错) throw e;
    throw new 接口出错(`读${谁}返回的内容时断了：${连不上原因(e)}`);
  }
  try {
    const j = JSON.parse(文本) as unknown;
    return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 一段段读完返回内容，单独挂一个钟：真 fetch 的超时信号也管读内容，但换了 fetch（代理、测试替身）不一定管，
 * 对方吐一半就停会一直挂着。到点取消读（连接放掉），抛 接口出错
 */
async function 读完(res: Response, 谁: string, 超时毫秒: number): Promise<string> {
  if (!res.body) return "";
  const 读者 = res.body.getReader();
  let 超了 = false;
  const 钟 = setTimeout(() => {
    超了 = true;
    读者.cancel().catch(() => {});
  }, 超时毫秒);
  try {
    const 解 = new TextDecoder();
    let 文本 = "";
    for (;;) {
      const { done, value } = await 读者.read();
      if (超了) throw new 接口出错(`读${谁}返回的内容时断了：等了 ${超时毫秒 / 1000} 秒没读完`);
      if (done) return 文本 + 解.decode();
      文本 += 解.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(钟);
  }
}
