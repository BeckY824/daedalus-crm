"use client";
/**
 * 滑动确认。**整个产品里只有一处用它**：清除演示数据——那一下会删掉库里全部业务数据。
 *
 * 形状参考 bencho.dev 的 Slide to confirm（MIT，见 licenses/bencho-MIT.txt），
 * 按我们的 token 重写。
 *
 * 为什么不是又一个「确定/取消」：那两个键长得和「保存」「取消」一模一样，
 * 手比脑子快的时候它挡不住任何人。滑一段 200px 挡得住，因为它要求的是**一个不会误发生的动作**。
 * 也正因为这样，它只配给真的回不来的那一下——每多用一处，它就少挡一点。
 *
 * 键盘上按 Enter 直接确认：一个只能用鼠标拖的闸门，对用键盘的人等于没有闸门，
 * 而不是更安全。真正的防线是"这一下要专门做"，不是"这一下很难做"。
 */
import { useEffect, useRef, useState } from "react";
import { motion, useMotionValue, useTransform } from "motion/react";

export default function SlideConfirm({
  话 = "滑动以确认",
  忙 = false,
  做,
}: {
  话?: string;
  忙?: boolean;
  做: () => void | Promise<void>;
}) {
  const 轨 = useRef<HTMLDivElement>(null);
  const [成了, set成了] = useState(false);
  /** 轨道宽度存进 state 而不是渲染时读 ref：读 ref 的那一帧还没量到，值会是 0 */
  const [轨宽, set轨宽] = useState(0);

  useEffect(() => {
    const el = 轨.current;
    if (!el) return;
    const 量 = () => set轨宽(el.clientWidth);
    量();
    // 框是响应式的，窗口变了轨道也跟着变，终点得跟着挪
    const ro = new ResizeObserver(量);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const x = useMotionValue(0);
  /** 拖到哪儿字就淡到哪儿：字是"还没做"的提示，做完它该自己让位 */
  const 字透明度 = useTransform(x, [0, 60], [1, 0]);

  async function 确认() {
    if (成了 || 忙) return;
    set成了(true);
    await 做();
  }

  return (
    <div className={`slc${成了 ? " on" : ""}`} ref={轨}>
      <motion.span className="slc-t" style={{ opacity: 成了 ? 0 : 字透明度 }}>
        {话}
      </motion.span>
      <motion.button
        type="button"
        className="slc-k"
        aria-label={`${话}（也可以按回车确认）`}
        drag={成了 || 忙 ? false : "x"}
        dragConstraints={轨}
        dragElastic={0.04}
        dragMomentum={false}
        style={{ x }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void 确认();
          }
        }}
        onDragEnd={() => {
          // 拖过八成就算数：最后那几像素是手抖的范围，不该由它决定删不删
          if (x.get() >= (轨宽 - 44) * 0.8) void 确认();
          else void x.set(0);
        }}
        animate={成了 ? { x: Math.max(0, 轨宽 - 44) } : undefined}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      >
        {成了 ? "✓" : "›"}
      </motion.button>
    </div>
  );
}
