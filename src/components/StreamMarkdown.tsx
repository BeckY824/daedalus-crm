"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import type { BriefRecord } from "@/lib/ai-draft";
import { MdBlock } from "@/components/Markdown";
import { 起出字, 收到, 走一拍, 放完, 还在动, 块们, type 出字状态 } from "@/lib/stream-reveal";

/**
 * 流式回答的 Markdown。和 <Markdown> 画出来的一样，多了两件事：
 *
 * - **按块渲染**：切成段落 / 列表 / 表格一块一块，前面写完的块 memo 住，
 *   来一个 token 只重渲最后那块（原来是整段重新解析一遍）
 * - **平滑出字**：到了多少和放出来多少分开，每 28ms 最多放一块，新放出的那截淡入；
 *   流一结束剩下的一次放完，所以不会比模型慢。节奏和切分都在 lib/stream-reveal.ts
 *
 * 开了「减弱动态」：不缓冲、不淡入，到多少出多少。
 *
 * 名字是英文的：react-hooks 规则按首字母大写认组件（见 Rise.tsx 的说明）。
 */
const 空引用 = new Map<number, BriefRecord>();

export default function StreamMarkdown({
  text,
  records,
  流着,
  出字了,
}: {
  text: string;
  records: BriefRecord[];
  流着: boolean;
  /** 每放出一截调一次。TurnView 拿它跟着往下滚：字是按帧放出来的，只跟「到了」会差最后一截 */
  出字了?: () => void;
}) {
  const 少动 = useReducedMotion();
  const 目标 = text.replace(/\r/g, "");
  const [快照, 设快照] = useState<出字状态>(() => 起出字(目标, 流着));
  /** 出字器的真实状态：token 一到就更新，但不重渲；每帧走一拍，放出了字才同步到 快照 */
  const 机 = useRef(快照);
  /** 最后一次交给 React 的那份，用来判断这一帧要不要重渲 */
  const 已画 = useRef(快照);
  const 帧 = useRef(0);

  useEffect(() => {
    // 文本到了、或者流结束了：记下来，没在走帧就开始走（至少走一帧，把这次的变化同步出去）
    机.current = 收到(机.current, 目标);
    if (!流着) 机.current = 放完(机.current, performance.now());
    if (帧.current) return;
    const 走 = () => {
      const 后 = 走一拍(机.current, performance.now());
      机.current = 后;
      // 只有「放出来多少」或淡入截变了才重渲；光是又到了几个字不算，那些还在排队
      if (后.显示长 !== 已画.current.显示长 || 后.最近 !== 已画.current.最近) {
        已画.current = 后;
        设快照(后);
      }
      帧.current = 还在动(后) ? requestAnimationFrame(走) : 0;
    };
    帧.current = requestAnimationFrame(走);
  }, [目标, 流着]);
  useEffect(
    () => () => {
      cancelAnimationFrame(帧.current);
      帧.current = 0;
    },
    [],
  );

  const 放出 = 快照.显示长;
  useEffect(() => {
    if (放出 > 0) 出字了?.();
    // 只在放出新字时跟；回调换了引用不算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [放出]);

  const byN = useMemo(() => (records.length ? new Map(records.map((r) => [r.n, r])) : 空引用), [records]);
  const 显示 = 少动 ? 目标 : 快照.目标.slice(0, 快照.显示长);
  const 最近 = 少动 ? null : 快照.最近;
  const 各块 = useMemo(() => 块们(显示, 最近 ? 最近.map((c) => c.起) : []), [显示, 最近]);
  return (
    <div className="md">
      {各块.map((b) => (
        <MdBlock key={b.起} 起={b.起} 文={b.文} 淡={b.淡} byN={byN} />
      ))}
    </div>
  );
}
