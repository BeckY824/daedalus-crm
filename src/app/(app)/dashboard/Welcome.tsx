"use client";
import { useSyncExternalStore } from "react";
import { motion } from "motion/react";
import { dayjs } from "@/lib/utils";
import Shortcut from "@/components/Shortcut";
import Signals from "./Signals";
import type { 首页信号 } from "./HomeChat";

/** 首页还没问过时的那一屏：问候、日期、三个信号、一句上下文 */
export default function Welcome({ userName, 信号, context }: { userName: string; 信号?: 首页信号; context: string }) {
  /*
    问候和日期都得在客户端算：服务端渲染出来的是服务器那台机器的「现在」。
    useSyncExternalStore 的第三个参数是服务端快照——先给一个不带时间的中性值，
    水合之后再换成真的，这样不会有 hydration mismatch，也不会闪一下别人的早上好。
  */
  const greet = useSyncExternalStore(
    () => () => {},
    () => {
      const h = dayjs().hour();
      return h < 5 ? "夜深了" : h < 12 ? "早上好" : h < 18 ? "下午好" : "晚上好";
    },
    () => "你好",
  );
  /** 问候底下那行日期（设计稿 06/HOME·ACTIVE）：今天是几号、星期几 */
  const 今天 = useSyncExternalStore(
    () => () => {},
    () => {
      const d = dayjs();
      return `${d.month() + 1} 月 ${d.date()} 日 · 周${"日一二三四五六"[d.day()]}`;
    },
    () => "",
  );

  return (
    <motion.div className="cli-welcome" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <div className="cli-welcome-t">
        {greet}，{userName}。
      </div>
      {今天 && <div className="cli-welcome-d">{今天}</div>}
      {/* 三个信号一行，不是三张卡。建议问题挪到输入框底下去了——
          人的视线落在输入框上，可点的问题就该在那儿，不在半屏之外 */}
      {信号 && <Signals 信号={信号} />}
      <div className="cli-welcome-s">{context}</div>
      <div className="cli-welcome-hints">
        <div>
          也可以直接问，或者让它记一笔、改状态、排计划——它给一张建议卡，你点确认才写入。输入 <kbd>/</kbd> 看命令，<kbd><Shortcut>⌘K</Shortcut></kbd> 回到输入框。
        </div>
      </div>
    </motion.div>
  );
}
