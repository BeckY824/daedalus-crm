/**
 * 动效的 JS 镜像。motion 认不了 CSS 变量，JS 里只能写数值——**只许写在这里**。
 *
 * 和 globals.css 的 :root 一一对应（tests/motion-tokens.test.ts 逐值对一遍，对不上就红）：
 *   曲线.ease   = --ease          曲线.spring = --ease-spring    曲线.morph = --ease-morph
 *   时长.press  = --t-press       时长.fast   = --t-fast
 *   时长.base   = --t             时长.morph  = --t-morph         时长.seal  = --t-seal
 *   间隔        = --stagger
 * 单位不同：CSS 写毫秒，这里是秒（motion 的 duration 按秒算）。
 *
 * 为什么要这一份：2026-09-28 之前 JS 里到处是各写各的数，已经和 CSS 对不上了——
 * Rise 0.42s 超过 320 上限（守卫只查样式表，查不到 JS）、时间线排队 40ms 而 Rise 70ms、
 * 左栏底块用的 [0.2, 0.8, 0.2, 1] 是第四条曲线、MotionConfig 默认 0.26 不是任何一档。
 * 现在 src 下别处写裸的 duration / ease 会被守卫抓出来。
 */

/** 和 motion 的 BezierDefinition 同形：直接传 `ease: 曲线.ease`，不用展开 */
type 贝塞尔 = readonly [number, number, number, number];

export const 曲线 = {
  /** 绝大多数：出现、消失、位移。起步快、收尾软 */
  ease: [0.22, 1, 0.36, 1],
  /** 只给「弹出来」的：菜单、开关拨柄、确认态。过冲一点点 */
  spring: [0.24, 1.34, 0.38, 1],
  /** 一个东西变成另一个东西：浮层长出来、卡片收成一行。两头慢中间快 */
  morph: [0.33, 0.55, 0.2, 1],
} as const satisfies Record<string, 贝塞尔>;

/** 秒 */
export const 时长 = {
  /** 按下：故意最短 */
  press: 0.09,
  /** 悬停、收起、撤销：要跟手的 */
  fast: 0.12,
  /** 绝大多数过渡 */
  base: 0.18,
  /** 形变；也是除落印以外的上限 */
  morph: 0.32,
  /** 落印专用，也只许它用（上限 0.48） */
  seal: 0.32,
} as const;

/**
 * 进场排队，一档的间隔（秒）。70ms：40ms 那一版排是排了但人看不出（2026-09-18 装机反馈），
 * 间隔要读得出先后，又不能读出「它在等」。超过八档就整组一起出来。
 */
export const 间隔 = 0.07;

/* ---------- 主题换了曲线和时长，JS 这边跟着读 ----------
 * 设置 → 外观 → 主题可以换 --ease-* / --t-* 的值（像素是阶跃、高级更慢更柔……，规矩见 src/app/skins/）。
 * CSS 动的那一半自己就跟着变了；motion 读不了 CSS 变量，所以在浏览器里从 <html> 上把当前值读出来，
 * 经 components/MotionTheme.tsx 发给各处（useMotionTheme()）。**上面那几个常量仍是现状的值、也是读不到时的兜底**。
 *
 * 读的规矩和样式表一样严：只认 cubic-bezier(…) 和 steps(n[, 起止])，时长只认 ms/s；
 * 认不出的那一项回到现状的值，不让一个写坏的主题把动效整个弄没。
 */
export type 缓动 = 贝塞尔 | ((t: number) => number);
export type 动效 = {
  曲线: { ease: 缓动; spring: 缓动; morph: 缓动 };
  时长: { press: number; fast: number; base: number; morph: number; seal: number };
  间隔: number;
};
export const 现状动效: 动效 = { 曲线, 时长, 间隔 };

/** steps(n, jump-end) 那种阶跃，写成 motion 认的缓动函数 */
function 阶跃(n: number, 起: string): (t: number) => number {
  const 先跳 = 起 === "start" || 起 === "jump-start" || 起 === "jump-both";
  return (t) => {
    if (t >= 1) return 1;
    const k = 先跳 ? Math.ceil(t * n) : Math.floor(t * n);
    return Math.min(1, Math.max(0, k / n));
  };
}

export function 读曲线(v: string | null | undefined, 兜底: 缓动): 缓动 {
  const s = (v ?? "").trim();
  const b = /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/.exec(s);
  if (b) {
    const 数 = b.slice(1, 5).map(Number);
    if (数.every(Number.isFinite)) return 数 as unknown as 贝塞尔;
  }
  const st = /^steps\(\s*(\d+)\s*(?:,\s*([\w-]+)\s*)?\)$/.exec(s);
  if (st && Number(st[1]) > 0) return 阶跃(Number(st[1]), st[2] ?? "end");
  return 兜底;
}

export function 读秒(v: string | null | undefined, 兜底: number): number {
  const m = /^([\d.]+)(ms|s)$/.exec((v ?? "").trim());
  if (!m) return 兜底;
  const n = Number(m[1]) / (m[2] === "ms" ? 1000 : 1);
  return Number.isFinite(n) ? n : 兜底;
}

/** 给一个「按名字取 CSS 变量」的函数（浏览器里是 getComputedStyle(html).getPropertyValue），读出当前主题的动效 */
export function 从样式读动效(取: (name: string) => string): 动效 {
  return {
    曲线: {
      ease: 读曲线(取("--ease"), 曲线.ease),
      spring: 读曲线(取("--ease-spring"), 曲线.spring),
      morph: 读曲线(取("--ease-morph"), 曲线.morph),
    },
    时长: {
      press: 读秒(取("--t-press"), 时长.press),
      fast: 读秒(取("--t-fast"), 时长.fast),
      base: 读秒(取("--t"), 时长.base),
      morph: 读秒(取("--t-morph"), 时长.morph),
      seal: 读秒(取("--t-seal"), 时长.seal),
    },
    间隔: 读秒(取("--stagger"), 间隔),
  };
}
