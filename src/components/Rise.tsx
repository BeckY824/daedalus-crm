"use client";
/**
 * 进场：淡入 + 16px 上浮。**整站只有这一种进场**。
 *
 * 用 `第几个` 排队：0、1、2、3，每档一个 `间隔`（70ms，--stagger）。40ms 那一版排是排了，
 * 但人看不出来（2026-09-18 装到机器上的反馈：「没感觉到哪里不一样」）——间隔要读得出先后，
 * 又不能读出"它在等"，70 是这两者之间。位移同理：8px 改 16px。
 * 超过五六档就该让整组一起出来，那时排队只剩下拖沓。
 *
 * 时长和曲线从 lib/motion.ts 拿（--t-morph + --ease 的数值版）。原来是 0.42s，
 * 超了 320 的上限——守卫那时只查样式表，查不到这里（2026-09-28 收到 0.32）。
 *
 * 开了「减弱动态」就一次到位：不是变快，是根本不动。CSS 那条全局兜底
 * 只管 transition 和 animation，管不到 JS 驱动的值，所以这里要自己读一次开关。
 *
 * 名字是英文的：eslint 的 react-hooks 规则按「首字母大写」认组件，
 * 中文名的函数里调 hook 会被判成非组件。属性名照旧用中文。
 */
import { motion, useReducedMotion } from "motion/react";
import { 曲线, 时长, 间隔 } from "@/lib/motion";

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
      initial={{ opacity: 0, y: 少动 ? 0 : 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 少动 ? 0 : 时长.morph, delay: 少动 ? 0 : 第几个 * 间隔, ease: 曲线.ease }}
    >
      {children}
    </motion.div>
  );
}
