"use client";
/**
 * 进场：淡入 + 8px 上浮。**整站只有这一种进场**。
 *
 * 用 `第几个` 排队：0、1、2、3，每档 40ms。人的眼睛读得出这个先后，
 * 但读不出它在等——超过五六档就该让整组一起出来，那时排队只剩下拖沓。
 *
 * 曲线是 globals.css 里的 --ease（cubic-bezier(.22,1,.36,1)，参考 bencho.dev）。
 * 这里写成数组是因为 motion 不认 CSS 变量——**同一条曲线，两个地方各写一遍**，
 * 改的时候两处都要改。
 *
 * 开了「减弱动态」就一次到位：不是变快，是根本不动。CSS 那条全局兜底
 * 只管 transition 和 animation，管不到 JS 驱动的值，所以这里要自己读一次开关。
 *
 * 名字是英文的：eslint 的 react-hooks 规则按「首字母大写」认组件，
 * 中文名的函数里调 hook 会被判成非组件。属性名照旧用中文。
 */
import { motion, useReducedMotion } from "motion/react";

export const 缓动 = [0.22, 1, 0.36, 1] as const;
/** 一档 40ms。和 CSS 里的 --t-fast 不是一回事：那是过渡时长，这是队列间隔 */
export const 一档 = 0.04;

export default function Rise({
  第几个 = 0,
  className,
  style,
  children,
}: {
  第几个?: number;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const 少动 = useReducedMotion();
  return (
    <motion.div
      className={className}
      style={style}
      initial={{ opacity: 0, y: 少动 ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 少动 ? 0 : 0.26, delay: 少动 ? 0 : 第几个 * 一档, ease: [...缓动] }}
    >
      {children}
    </motion.div>
  );
}
