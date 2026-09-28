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
 *
 * 数组要展开再传（`ease: [...曲线.ease]`）：motion 的类型要可变数组，这里是 readonly。
 */

export const 曲线 = {
  /** 绝大多数：出现、消失、位移。起步快、收尾软 */
  ease: [0.22, 1, 0.36, 1],
  /** 只给「弹出来」的：菜单、开关拨柄、确认态。过冲一点点 */
  spring: [0.24, 1.34, 0.38, 1],
  /** 一个东西变成另一个东西：浮层长出来、卡片收成一行。两头慢中间快 */
  morph: [0.33, 0.55, 0.2, 1],
} as const;

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
