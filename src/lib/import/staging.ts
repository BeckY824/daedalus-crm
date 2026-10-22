/**
 * 大表先分块交给服务端暂存，预览、落库再按「暂存号」取（2026-10-21 用户放行：一次导上万条、带进度）。
 *
 * 为什么要这一层：预览、落库都是 server action，Next 默认一次最多收 1 MB。9 列的外贸表约 3000 行就超了，
 * 原来整张表当参数送过去，第 2 步点「下一步」只弹一句英文（Body exceeded 1 MB limit）。
 * 不去放宽全站的上限（团队版服务器上每个 action 都会跟着能收几十 MB），而是导入这一条路自己分块送。
 *
 * 只放在这个进程的内存里：桌面端、团队版服务器都是单进程。进程重启了就没了——
 * 调用方拿到「暂存过期」会把表重新送一遍（抽屉里的那份一直在），人感觉不到。
 */

/** 一份暂存多久没人碰就扔。人在第 3 步犹豫半小时再点「开始导入」，抽屉会重新送 */
const 留多久 = 30 * 60_000;
/** 每人最多同时暂存几份：开了两个窗口、点过重来，旧的不用等过期 */
const 每人几份 = 3;
/** 和 parse.ts 的上限一致：10000 行 × 50 列 */
export const 暂存行上限 = 10000;
export const 暂存列上限 = 50;

type 一份 = { userId: string; 表头: string[]; 共: number; 数据: string[][]; 行号?: number[]; 碰过: number };

// 挂在 globalThis 上：Next 按页面分包，同一个模块可能被装进不同的包里各有一份；和 lib/prisma 的单例同一个做法
const 全局 = globalThis as unknown as { __导入暂存?: Map<string, 一份> };
const 暂存 = (全局.__导入暂存 ??= new Map<string, 一份>());

function 清过期(现在: number) {
  for (const [k, v] of 暂存) if (现在 - v.碰过 > 留多久) 暂存.delete(k);
}

export type 一块 = {
  /** 这一块从第几条数据开始（0 起）。必须紧接着上一块：乱序、重送的块直接报错，让调用方从头送 */
  起: number;
  数据: string[][];
  行号?: number[];
};

/** 收一块。第一块（起 = 0）带表头和总条数，开一份新的（同号的旧份作废） */
export function 收块(userId: string, 号: string, 块: 一块, 头?: { 表头: string[]; 共: number }): { ok: true; 收到: number } | { ok: false; error: string } {
  const 现在 = Date.now();
  清过期(现在);
  if (!/^[\w-]{8,64}$/.test(号)) return { ok: false, error: "暂存号不对" };
  if (块.起 === 0) {
    if (!头) return { ok: false, error: "第一块要带表头" };
    if (头.共 > 暂存行上限 || 头.表头.length > 暂存列上限) return { ok: false, error: `一次最多导 ${暂存行上限} 行、${暂存列上限} 列` };
    const 我的 = [...暂存].filter(([k, v]) => v.userId === userId && k !== 号).sort((a, b) => a[1].碰过 - b[1].碰过);
    for (const [k] of 我的.slice(0, Math.max(0, 我的.length - (每人几份 - 1)))) 暂存.delete(k);
    暂存.set(号, { userId, 表头: 头.表头.map(String), 共: 头.共, 数据: [], 行号: 块.行号 ? [] : undefined, 碰过: 现在 });
  }
  const 份 = 暂存.get(号);
  if (!份 || 份.userId !== userId) return { ok: false, error: "暂存过期" };
  if (块.起 !== 份.数据.length) return { ok: false, error: "暂存过期" };
  if (份.数据.length + 块.数据.length > 份.共) return { ok: false, error: "这份表比开头说的多" };
  if (Boolean(份.行号) !== Boolean(块.行号) || (块.行号 && 块.行号.length !== 块.数据.length)) return { ok: false, error: "行号和数据对不上" };
  for (const r of 块.数据) 份.数据.push(r.slice(0, 暂存列上限).map((x) => (typeof x === "string" ? x : String(x ?? ""))));
  if (块.行号) 份.行号!.push(...块.行号.map(Number));
  份.碰过 = 现在;
  return { ok: true, 收到: 份.数据.length };
}

/** 取一份收齐了的。没有、不是这个人的、没收齐都算过期（调用方重送） */
export function 取暂存(userId: string, 号: string): { 表头: string[]; 数据: string[][]; 行号?: number[] } | null {
  const 现在 = Date.now();
  清过期(现在);
  const 份 = 暂存.get(号);
  if (!份 || 份.userId !== userId || 份.数据.length !== 份.共) return null;
  份.碰过 = 现在;
  return { 表头: 份.表头, 数据: 份.数据, 行号: 份.行号 };
}

/** 测试用：清空 */
export function 清空暂存() {
  暂存.clear();
}
