"use client";
/**
 * 就地确认。**这个按钮自己变成问句**，不弹框。
 *
 * 形状参考 bencho.dev 的 Inline confirm（MIT，见 licenses/bencho-MIT.txt），
 * 结构和数值按我们的 token 重写过。
 *
 * 什么时候用它、什么时候还是弹框——这条线不能含糊：
 *   就地确认 —— 一件事、一句话说得完、删了还能再写一条（比如一条跟进记录）
 *   还是弹框 —— 后果要解释（级联删除、金额归零、跟进状态要退回），或者一次动很多条
 * 弹框的价值在那段解释，不在"多点一下"。把有解释的那些也改成就地确认，
 * 等于把解释扔了，那不是轻，是糊弄。
 *
 * 展开时右边的两个键会把原来那行挤开，所以它只放在末尾一列。
 * 5 秒没动静自己收回去：人多半是点错了然后走开了，一个一直张着嘴的确认条很吵。
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { 曲线, 时长 } from "@/lib/motion";

export default function InlineConfirm({
  问,
  做,
  children,
  是 = "删除",
  开: 外开,
  set开: 外set开,
}: {
  /** 问句。一句话，不带句号——它和两个键在同一行 */
  问: string;
  做: () => void | Promise<void>;
  /** 平时那颗键。展开之后它会被问句替掉 */
  children: React.ReactNode;
  /** 确认键上的字。默认「删除」；不是删除的事（比如标丢单）要写成那件事本身 */
  是?: string;
  /**
   * 受控：由外面决定什么时候展开（比如从「更多」菜单里点进来）。
   * 受控时点平时那颗键**不会**展开——那颗键可能是一整排别的按钮。
   */
  开?: boolean;
  set开?: (v: boolean) => void;
}) {
  const [内开, set内开] = useState(false);
  const 开 = 外开 ?? 内开;
  const set开 = 外set开 ?? set内开;
  const [忙, set忙] = useState(false);
  const 计时 = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 外面传进来的 set开 多半是每次渲染新建的箭头函数；放进依赖里，5 秒的计时会被每次重渲重置
  const 收起 = useRef(set开);
  useEffect(() => {
    收起.current = set开;
  });

  useEffect(() => {
    if (!开) return;
    计时.current = setTimeout(() => 收起.current(false), 5000);
    return () => {
      if (计时.current) clearTimeout(计时.current);
    };
  }, [开]);

  async function 确认() {
    set忙(true);
    try {
      await 做();
      set开(false);
    } finally {
      set忙(false);
    }
  }

  return (
    <span className="inlc" onKeyDown={(e) => e.key === "Escape" && set开(false)}>
      <AnimatePresence initial={false} mode="popLayout">
        {开 ? (
          <motion.span
            key="ask"
            className="inlc-ask"
            initial={{ opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 6 }}
            transition={{ duration: 时长.base, ease: 曲线.spring }}
          >
            <span className="inlc-q">{问}</span>
            <button type="button" className="inlc-yes" disabled={忙} onClick={() => void 确认()}>
              {是}
            </button>
            <button type="button" className="inlc-no" onClick={() => set开(false)}>
              取消
            </button>
          </motion.span>
        ) : (
          <motion.span
            key="btn"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 时长.fast, ease: 曲线.ease }}
            onClick={外开 === undefined ? () => set开(true) : undefined}
          >
            {children}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
