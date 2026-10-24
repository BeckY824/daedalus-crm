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
export class 接口出错 extends Error {}

/** 被限流时最多重试几次、每次等多久（1s、2s、4s…，封顶 30s） */
export const 最多重试 = 5;
export const 退避 = (第几次: number) => Math.min(30_000, 1000 * 2 ** 第几次);

/** 毫秒时间戳 → 北京时间「2026-10-24 09:30」；整点零分的只给日期 */
export function 北京时间串(ms: number): string {
  const d = new Date(ms + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const 日 = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const 时 = d.getUTCHours();
  const 分 = d.getUTCMinutes();
  return 时 === 0 && 分 === 0 ? 日 : `${日} ${p(时)}:${p(分)}`;
}

export async function 读JSON(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const j = await res.json();
    return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
