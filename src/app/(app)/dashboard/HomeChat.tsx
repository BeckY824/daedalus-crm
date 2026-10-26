"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import type { 页面范围 } from "@/lib/ai-context-page";
import { useModel } from "@/components/ModelPicker";
import type { ModelOption } from "@/lib/llm";
import { useBusiness } from "@/lib/business-client";
import { 首页屏 } from "@/lib/home-thread";
import type { 历史消息 } from "@/lib/thread-history";
import PaneToggle from "@/components/PaneToggle";
import StartCard from "./StartCard";
import Welcome from "./Welcome";
import TurnLog, { type 一轮的动作 } from "./TurnLog";
import Composer, { type ComposerHandle } from "./Composer";
import { useHomeTurns } from "./useHomeTurns";
import LeadFullNotices from "../leads/LeadFullNotices";
import type { 满额提醒 } from "@/lib/enterprise/lead-full-notice";

export type Suggestion = { label: string; question: string; kind?: "ask" | "prep" | "recap" };

/**
 * 首页 = 一个对话面，交互照 Claude Code / Codex：
 *   一轮 = 右侧你的问题气泡 → 过程（工具调用一行一条，答完折成一句摘要，点开看）→ 逐字流出的回答
 *          → 涉及的客户卡片（打开 / 起草）→ 底部一排小图标（复制 / 重试 / 移除）和用时
 *   输入框：Enter 发送；正在答时 Enter 或 ⌘↵ 排队，等它答完自动发；Shift+Enter 换行；/ 出命令单
 *   打断：Esc、Ctrl+C，或点右侧的停止键；中断后留一行「已中断」，已流出的字不丢
 * 背后是一个 agent 循环：模型自己决定读谁、查什么，工具全部只读。
 *
 * 2026-10-24 拆成四块：对话本身（useHomeTurns）、欢迎屏（Welcome）、已问过的那一列（TurnLog）、
 * 输入框（Composer）。打字只重渲输入框，流式出字只重渲正在流的那一轮。
 */
/** 本月签约按币种分开（2026-10-03，不换汇）；空数组 = 这个月还没签 */
export type 首页信号 = { 逾期: number; 高意向: number; 本月签约: { 币种: string; 合计: number }[]; 高意向标签: string };

export default function HomeChat({ 会话, userName, suggestions, context, models, 空库, 信号, 模式 = "宽", 上下文提示, 上下文范围, scope = 首页屏, 标题前缀, 自己服务器 = false, 去导入 = false, 企业版 = false, 满额提醒 = [] }: {
  /** 地址上 ?c= 指的那条对话，服务端读好传进来。null = 一屏新对话 */
  会话: { id: string; title: string; messages: 历史消息[] } | null;
  userName: string;
  suggestions: Suggestion[];
  context: string;
  models: ModelOption[];
  /** 一条业务数据都没有：换成一张「开始」卡 */
  空库: boolean;
  信号?: 首页信号;
  /**
   * 宽 = 首页，对话就是整页，带问候、信号、建议问题。
   * 窄 = 右侧全局面板（AiDock），只有对话本身——380 宽塞不下那些，
   * 而且人是在**别的页面上**顺手问一句，不需要再被问候一次。
   */
  模式?: "宽" | "窄";
  /** 窄模式下带的当前页上下文（见 lib/ai-context-page.ts）。宽模式没有这回事 */
  上下文提示?: string;
  /** 同一份上下文的结构化那半：这一页是哪张表、上面列着谁。给服务端的意图直连用 */
  上下文范围?: 页面范围;
  /**
   * 这一屏归哪儿。首页是 `首页屏`，全局面板按 pathname 一页一屏——
   * **不给就会和首页共用一屏**，那正是 2026-09-19 报上来的「在线索页问一句，
   * 所有页面都有记录」。见 lib/home-thread.ts 的说明。
   */
  scope?: string;
  /**
   * 落库时给对话标题加的前缀（「线索 · 」）。首页不加。
   * 每一页各问各的之后，首页那条列表里会并排躺着好几条对话，
   * 光看问题本身认不出是在哪一页问的。
   */
  标题前缀?: string;
  /** 空库那张「开始」卡用：跑在客户自己部署的服务器上（见 StartCard） */
  自己服务器?: boolean;
  /** 空库那张「开始」卡用：企业版管理员，主按钮去企业版导入（见 StartCard） */
  去导入?: boolean;
  /** 空库那张「开始」卡用：企业版换成项目那条线的引导（见 StartCard） */
  企业版?: boolean;
  /** 首页才给：企业版自动分配因都已满额没分出去的提醒，摆在问答列最上面（lib/enterprise/lead-full-notice.ts） */
  满额提醒?: 满额提醒[];
}) {
  const b = useBusiness();
  const model = useModel(models);
  const 屏 = useHomeTurns({ 会话, scope, model, 模式, 上下文提示, 上下文范围, 标题前缀 });
  const { turns } = 屏;
  /** 刚发出去的那一问。只有它会在挂载时把自己滚到视口顶部，翻历史不该乱跳 */
  const [刚发的, set刚发的] = useState<string | null>(null);
  const composerRef = useRef<ComposerHandle>(null);

  /*
    给 TurnLog 的那份动作只造一次，调用时再去取最新的 start / running：
    每次渲染都新造的话，memo 过的 TurnLog 会因为 props 变了跟着重渲，拆开就白拆了
  */
  const 最新 = useRef({ start: 屏.start, running: 屏.running });
  useLayoutEffect(() => {
    最新.current = { start: 屏.start, running: 屏.running };
  });
  const [动作] = useState<一轮的动作>(() => ({
    start: (t) => 最新.current.start(t),
    在跑: () => 最新.current.running != null,
    问: (q) => composerRef.current?.问(q),
  }));

  const empty = turns.length === 0;
  const 窄 = 模式 === "窄";

  return (
    <div className={`cli${empty ? " cli-empty" : ""}${窄 ? " cli-narrow" : ""}`}>
      {/* 首页对话列表收起了（或窗口太窄成了抽屉）：问答区左上角一颗侧栏图标把它叫回来，和列表页头上那颗是同一个。右侧 AI 面板（窄）里不摆 */}
      {!窄 && <PaneToggle 栏="chat" 位置="主区" className="pane-toggle-float" />}
      <div className="cli-col">
        {!窄 && <LeadFullNotices 提醒={满额提醒} />}
        {empty && 窄 ? (
          /*
            窄模式（右侧面板）的空屏：380 宽塞不下问候、信号、建议问题那一套，
            而且人是在**别的页面上**顺手问一句，不需要再被问候一次。
            只留一句说明——它还要告诉人「这儿带着当前页」。
          */
          <div className="cli-narrow-hint">
            问一句关于这一页的，或者任何{b.customer}、任何数。
            <br />
            输入 <kbd>/</kbd> 看命令。
          </div>
        ) : empty && 空库 ? (
          /* 一条业务数据都没有：不摆信号、不摆建议问题，只有一张「开始」卡 */
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
            <StartCard 自己服务器={自己服务器} 去导入={去导入} 企业版={企业版} />
          </motion.div>
        ) : empty ? (
          <Welcome userName={userName} 信号={信号} context={context} />
        ) : (
          <TurnLog turns={turns} 刚发的={刚发的} scope={scope} 动作={动作} />
        )}

        <Composer
          ref={composerRef}
          屏={屏}
          scope={scope}
          models={models}
          model={model}
          模式={模式}
          suggestions={suggestions}
          空库={空库}
          on发出={set刚发的}
        />
      </div>
    </div>
  );
}
