import type { 轻行 } from "@/lib/plans-page";

/**
 * 跟进计划页轻列表的紧凑写法（2026-10-25 企业版压测）。
 *
 * 企业版 1.5 万条未完成事项时，轻列表 [key, 时间, 负责人下标] 一行约 65 字节，整页 RSC 1 MB、HTML 1.3 MB，
 * 几乎全是它。换成按列存：key 去掉 plan: / task: 前缀拼成一个字符串，ISO 时间存成和上一条的差（毫秒数按
 * 最大公约的单位除），日期串、空照原样。页面拿到后 解轻() 还原，和 取计划页() 给的轻列表一字不差
 * （tests/plans-light.test.ts 对拍）。还原不了的情况（key 里有逗号、前缀不认识）压轻() 返回 null，照原来整份给。
 */
export type 紧轻 = {
  /** 每条一个字符：p 计划、t 待办，后面跟 id；条与条之间用逗号隔开 */
  键: string;
  /** ISO 时间：和上一个 ISO 时间的差（单位见 单位）；日期串（YYYY-MM-DD）、null 原样 */
  时: (number | string | null)[];
  单位: number;
  人: number[];
  负责人: string[];
};

const 前缀 = { "plan:": "p", "task:": "t" } as const;
const 还原前缀: Record<string, string> = { p: "plan:", t: "task:" };

/** 这一串能不能写成毫秒数再原样写回来 */
function ISO毫秒(s: string): number | null {
  const ms = Date.parse(s);
  return Number.isFinite(ms) && new Date(ms).toISOString() === s ? ms : null;
}

/**
 * 同一份轻列表只压一次：不限定的人从 取计划页() 拿到的是缓存里共用的那份（同一个数组），压好的结果也共用。
 * 按数组本身记（WeakMap），那份被缓存换掉就跟着回收；负责人是从同一份算出来的，跟着轻走
 */
const 压过 = new WeakMap<readonly 轻行[], { 负责人: readonly string[]; 紧: 紧轻 | null }>();

export function 压轻(轻: readonly 轻行[], 负责人: readonly string[]): 紧轻 | null {
  const 有 = 压过.get(轻);
  if (有 && 有.负责人 === 负责人) return 有.紧;
  const 紧 = 现压(轻, 负责人);
  压过.set(轻, { 负责人, 紧 });
  return 紧;
}

function 现压(轻: readonly 轻行[], 负责人: readonly string[]): 紧轻 | null {
  const 键: string[] = [];
  for (const [key] of 轻) {
    const 头 = key.slice(0, 5);
    if (!Object.hasOwn(前缀, 头) || key.includes(",")) return null;
    键.push(前缀[头 as keyof typeof 前缀] + key.slice(5));
  }
  const 毫秒 = 轻.map(([, 时间]) => (时间 === null ? null : ISO毫秒(时间)));
  const 单位 = [60_000, 1_000, 1].find((u) => 毫秒.every((ms) => ms === null || ms % u === 0))!;
  let 上一个 = 0;
  const 时 = 轻.map(([, 时间], i) => {
    const ms = 毫秒[i];
    if (ms === null) return 时间;
    const 差 = (ms - 上一个) / 单位;
    上一个 = ms;
    return 差;
  });
  return { 键: 键.join(","), 时, 单位, 人: 轻.map(([, , i]) => i), 负责人: [...负责人] };
}

/** 还原成 PlansView 用的 { key, 时间, ownerId }，和直接拿轻列表展开的一样 */
export function 解轻(紧: 紧轻): { key: string; 时间: string | null; ownerId: string }[] {
  if (紧.人.length === 0) return [];
  const 键 = 紧.键.split(",");
  let 上一个 = 0;
  return 键.map((k, i) => {
    const t = 紧.时[i];
    let 时间: string | null;
    if (typeof t === "number") {
      上一个 += t * 紧.单位;
      时间 = new Date(上一个).toISOString();
    } else 时间 = t;
    return { key: 还原前缀[k[0]] + k.slice(1), 时间, ownerId: 紧.负责人[紧.人[i]] };
  });
}
