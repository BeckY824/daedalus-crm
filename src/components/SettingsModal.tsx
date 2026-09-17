"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { CloseOutlined } from "@ant-design/icons";
import { motion, useReducedMotion } from "motion/react";

/**
 * 设置的浮层。**设置不是一页，是一层**——照 Claude / Codex 桌面端那样，
 * 它盖在你正看的东西上面，关掉就回到原处，不打断手里的事。
 *
 * 装它的是 Next 的**拦截路由**（app/(app)/@modal/(.)settings），所以：
 *   - 地址仍然是 /settings，能分享、能收藏、后退键就是关闭
 *   - 刷新或者直接敲这个地址，落到的是整页那份（同一个 SettingsBody，不会两套）
 *   - 桌面端菜单里的 ⌘, 是硬导航，也落整页——那时人是奔着设置来的，不需要浮层
 *
 * 没用 antd 的 Modal：这一层里有自己的左目录和滚动区，Modal 那套 padding 和
 * 内置滚动会和它打架；一个 div 加一层遮罩反而更少东西要拆。
 */
export default function SettingsModal({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const 少动 = useReducedMotion();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.back();
    };
    window.addEventListener("keydown", onKey);
    // 浮层开着时底下不跟着滚——两层滚动条会让人不知道自己在滚哪一层
    const 原来的 = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = 原来的;
    };
  }, [router]);

  return (
    <motion.div
      className="setm"
      role="presentation"
      onClick={() => router.back()}
      /* 遮罩跟着淡，比浮层快一档：先暗下去，再看见设置长出来 */
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 少动 ? 0 : 0.16 }}
    >
      <motion.div
        className="setm-box"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        /* 它是**长出来的**，不是飞进来的：从 0.985 长到 1，位移只有 6px。
           曲线用形变那条（两头慢、中间快），因为这一层的意思是「当前这一页变成了设置」，
           不是「有个东西飞过来了」。0.26s——再快就看不出它从哪儿来 */
        initial={{ opacity: 0, y: 少动 ? 0 : 6, scale: 少动 ? 1 : 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 少动 ? 0 : 0.26, ease: [0.33, 0.55, 0.2, 1] }}
        /* 点在浮层里面不关——只有点到外面那层灰才算「我要走了」 */
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="setm-x" aria-label="关闭设置" onClick={() => router.back()}>
          <CloseOutlined />
        </button>
        <div className="setm-scroll">{children}</div>
      </motion.div>
    </motion.div>
  );
}
