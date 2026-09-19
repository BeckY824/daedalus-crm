"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { App, Dropdown, Tooltip } from "antd";
import { ArrowUpOutlined, CopyOutlined, ReloadOutlined, CloseOutlined, RightOutlined } from "@ant-design/icons";
import { motion } from "motion/react";
import type { BriefRecord } from "@/lib/ai-draft";
import ProposalCard from "@/components/ProposalCard";
import ModelPicker, { useModel, setModel } from "@/components/ModelPicker";
import AskFiles, { type 附件 } from "@/components/AskFiles";
import type { ModelOption } from "@/lib/llm";
import type { Proposal } from "@/lib/agent/proposals";
import { draftWakeup } from "./ai";
import { draftInvite } from "../channels/ai";
import Markdown from "@/components/Markdown";
import { useBusiness } from "@/lib/business-client";
import { clearJob, getJob, runJob, setJobValue, useJob, useRunningKey } from "@/lib/ai-jobs";
import { runStream, cancelStream, type StreamJob } from "@/lib/ai-stream";
import { addTurn, clearThread, dequeueTurn, removeTurn, useThread, 载入对话, 认领对话, 当前对话, 首页屏, type Turn } from "@/lib/home-thread";
import { 落一轮, type 历史消息 } from "./threads";
import AskBox from "@/components/AskBox";
import StartCard from "./StartCard";
import Signals from "./Signals";
import type { StepEvent } from "@/lib/ai-steps";
import { summarizeSteps } from "@/lib/agent/step-summary";
import { dayjs } from "@/lib/utils";

export type Suggestion = { label: string; question: string; kind?: "ask" | "prep" | "recap" };

/**
 * 把库里读回来的消息摊成这一屏的「轮」。
 *
 * 一轮 = 一条 user + 紧跟着的一条 assistant。turn 的 id 直接用那条 user 消息的 id，
 * 这样 ai-jobs 里的 key（home:<id>）在刷新前后是同一个，不会翻一次历史多出一份任务。
 *
 * **建议卡不还原**：那是「要不要写进库」的待办，人当时已经处理过了；
 * 隔天翻历史再弹一张「点确认就写入」的卡片，等于把一件做完的事重新摆回台面。
 */
function 历史成屏(messages: 历史消息[]): { turns: Turn[]; jobs: { key: string; value: StreamJob<AgentAnswer> }[] } {
  const turns: Turn[] = [];
  const jobs: { key: string; value: StreamJob<AgentAnswer> }[] = [];
  for (let i = 0; i < messages.length; i++) {
    const u = messages[i];
    if (u.role !== "user") continue;
    const a = messages[i + 1]?.role === "assistant" ? messages[i + 1] : null;
    if (!a) continue;
    i++;
    turns.push({ id: u.id, question: u.text, kind: "ask", at: Date.parse(u.createdAt) });
    const refs = (a.refs ?? {}) as { records?: BriefRecord[]; customers?: AgentAnswer["customers"] };
    jobs.push({
      key: `home:${u.id}`,
      value: {
        steps: (Array.isArray(a.steps) ? a.steps : []) as StepEvent[],
        text: a.text,
        ms: a.ms ?? undefined,
        answer: { text: a.text, records: refs.records ?? [], customers: refs.customers ?? [], proposals: [] },
      },
    });
  }
  return { turns, jobs };
}

type AgentAnswer = { text: string; records: BriefRecord[]; customers: { id: string; name: string; followStatus: string }[]; proposals: Proposal[] };

/** 斜杠命令：像 Claude Code 那样，输入 / 弹一张单子 */
const COMMANDS: { cmd: string; hint: string; question: string }[] = [
  { cmd: "/prep", hint: "准备下次跟进：找我最该联系的那位，读完记录给建议", question: "看一下我未完成的跟进计划，挑最该准备的那位，读完记录告诉我这次该谈什么" },
  { cmd: "/recap", hint: "回顾上次沟通：上次跟的那位聊到哪了", question: "找我最近一次跟进的那位，读记录，告诉我上次聊到哪、有什么没接住" },
  { cmd: "/watch", hint: "盯盘：正在被遗忘的人，各自该从哪接上", question: "看盯盘清单，对前几位各给一句现在该从哪接上" },
  { cmd: "/model", hint: "换个模型", question: "" },
  { cmd: "/board", hint: "打开数据看板", question: "" },
  { cmd: "/clear", hint: "清空这一屏", question: "" },
];

/**
 * 首页 = 一个对话面，交互照 Claude Code / Codex：
 *   一轮 = 右侧你的问题气泡 → 过程（工具调用一行一条，答完折成一句摘要，点开看）→ 逐字流出的回答
 *          → 涉及的客户卡片（打开 / 起草）→ 底部一排小图标（复制 / 重试 / 移除）和用时
 *   输入框：Enter 发送；正在答时 Enter 或 ⌘↵ 排队，等它答完自动发；Shift+Enter 换行；/ 出命令单
 *   打断：Esc、Ctrl+C，或点右侧的停止键；中断后留一行「已中断」，已流出的字不丢
 * 背后是一个 agent 循环：模型自己决定读谁、查什么，工具全部只读。
 */
export type 首页信号 = { 逾期: number; 高意向: number; 本月签约: number; 高意向标签: string };

export default function HomeChat({ 会话, userName, suggestions, context, models, aiQuota, 空库, 信号, 模式 = "宽", 上下文提示, scope = 首页屏, 标题前缀 }: {
  /** 地址上 ?c= 指的那条对话，服务端读好传进来。null = 一屏新对话 */
  会话: { id: string; title: string; messages: 历史消息[] } | null;
  userName: string;
  suggestions: Suggestion[];
  context: string;
  models: ModelOption[];
  aiQuota?: { 上限: number; 还剩: number } | null;
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
}) {
  const b = useBusiness();
  const router = useRouter();
  const turns = useThread(scope);
  const 地址栏 = useSearchParams();
  const model = useModel(models);
  /** 这一问要带的文件。发出去就清空——它属于那一问，不属于这个输入框 */
  const [files, setFiles] = useState<附件[]>([]);
  const [q, setQ] = useState("");
  const [cmdIdx, setCmdIdx] = useState(0);
  /** 输入框空着时，↑↓ 在下面那排建议问题里选，回车就发。-1 = 没选 */
  const [suggIdx, setSuggIdx] = useState(-1);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  /** 刚发出去的那一问。只有它会在挂载时把自己滚到视口顶部，翻历史不该乱跳 */
  const [刚发的, set刚发的] = useState<string | null>(null);
  /*
    问候和日期都得在客户端算：服务端渲染出来的是服务器那台机器的「现在」。
    useSyncExternalStore 的第三个参数是服务端快照——先给一个不带时间的中性值，
    水合之后再换成真的，这样不会有 hydration mismatch，也不会闪一下别人的早上好。
  */
  const greet = useSyncExternalStore(
    () => () => {},
    () => {
      const h = new Date().getHours();
      return h < 5 ? "夜深了" : h < 12 ? "早上好" : h < 18 ? "下午好" : "晚上好";
    },
    () => "你好",
  );
  /** 问候底下那行日期（设计稿 06/HOME·ACTIVE）：今天是几号、星期几 */
  const 今天 = useSyncExternalStore(
    () => () => {},
    () => {
      const d = new Date();
      return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${"日一二三四五六"[d.getDay()]}`;
    },
    () => "",
  );

  const runningKey = useRunningKey(turns.map((t) => `home:${t.id}`));

  /**
   * 库 → 这一屏。
   *
   * 只在「换了一条对话」时真的换内容（见 home-thread 的 载入对话）：
   * 从客户页切回首页也会跑这个 effect，那时候不能把正在流的那一轮冲掉。
   * 地址上没有 ?c= 时什么都不做——新建对话走的是中栏那颗键，不是靠地址栏。
   */
  useEffect(() => {
    if (!会话) return;
    const { turns: 轮, jobs } = 历史成屏(会话.messages);
    if (!载入对话(scope, 会话.id, 轮)) return;
    for (const j of jobs) setJobValue(j.key, j.value);
    // 历史那几轮本来就在库里，别再落一遍
    for (const t of 轮) 已落.current.add(t.id);
  }, [会话]);

  /**
   * 答完一轮就落库。
   *
   * 在这儿做而不是在 runStream 里：那边是模块级的，不认识「当前是哪条对话」，
   * 也没有 router。先把 id 记进 已落 再发请求——这个 effect 会因为任务表变动
   * 跑好几次，不占位的话同一轮会落两遍。
   */
  const 已落 = useRef(new Set<string>());
  useEffect(() => {
    void (async () => {
      for (const t of turns) {
        if (已落.current.has(t.id)) continue;
        const job = getJob<StreamJob<AgentAnswer>>(`home:${t.id}`);
        if (job?.status !== "done") continue;
        const 答 = (job.value?.answer?.text ?? job.value?.text ?? "").trim();
        已落.current.add(t.id);
        if (!答) continue;
        const r = await 落一轮({
          conversationId: 当前对话(scope),
          question: t.question,
          answer: 答,
          model,
          ms: job.value?.ms ?? null,
          steps: job.value?.steps,
          // 建议卡不存：它是一件当时就处理完的事，翻历史不该再摆回来
          refs: { records: job.value?.answer?.records ?? [], customers: job.value?.answer?.customers ?? [] },
          标题前缀: 标题前缀,
        });
        认领对话(scope, r.conversationId);
        /*
          地址对上那条对话（replace：翻历史时后退键不该退回「同一屏但没有 ?c=」）。
          **只在首页做**：窄模式下人在客户页顺手问一句，把地址改成 /dashboard 就是把他跳走了。
        */
        if (模式 === "宽") router.replace(`/dashboard?c=${r.conversationId}`, { scroll: false });
        // 中栏那条列表要跟着出现 / 换顺序
        router.refresh();
      }
    })();
  }, [turns, runningKey, model, router, 模式, scope, 标题前缀]);
  const running = runningKey ? turns.find((t) => `home:${t.id}` === runningKey) : undefined;
  const queued = turns.find((t) => t.queued);
  const showCmds = q.startsWith("/") && !q.includes(" ");
  const cmdMatches = showCmds ? COMMANDS.filter((c) => c.cmd.startsWith(q.trim())) : [];

  /**
   * 把这一问之前已经答完的几轮带上去，模型才接得住「他」「那个」「再约一下」。
   *
   * 只取答完的：还在流的那条文本是半截的，喂回去只会让它照着半截往下编。
   * 条数和长度这里先收一道，服务端还会再收一道——上下文是要按 token 付钱的，
   * 而且它会原样进 prompt，两边都不能只信对方。
   */
  function 收集上下文(到: string): { q: string; a: string }[] {
    const out: { q: string; a: string }[] = [];
    for (const t of turns) {
      if (t.id === 到) break;
      const job = getJob<StreamJob<AgentAnswer>>(`home:${t.id}`);
      if (job?.status !== "done") continue;
      const a = (job.value?.answer?.text ?? job.value?.text ?? "").trim();
      if (a) out.push({ q: t.question, a });
    }
    return out.slice(-6);
  }

  function start(turn: Turn) {
    runStream<AgentAnswer>(
      `home:${turn.id}`,
      { mode: "agent", question: turn.question, model, history: 收集上下文(turn.id), files: turn.files, pageContext: 上下文提示 },
      undefined,
      // 带上标签，这一问就会出现在侧栏的「AI 任务」里：切去别的页面也看得见它跑完没有，
      // 点一下回到这一条。问题本身当名字，截短到一行
      // 窄模式下人在别的页面问的，点任务不该把他拽去首页——留在原地，面板里那一条就是
      { 名: turn.question.slice(0, 18), 去: 模式 === "宽" ? `/dashboard#turn-${turn.id}` : undefined },
    );
  }

  /**
   * ⌘K 里直接问的那一句会带在地址上（/dashboard?q=…）。
   * 到了这儿就发出去，然后把 q 从地址里抹掉——留着的话刷新一次会再问一遍。
   *
   * 那个 ref 不是多余的：开发模式下 StrictMode 会把 effect 跑两遍（挂载 → 清理 → 再挂载），
   * 而 router.replace 生效没那么快，结果就是同一句话问了两遍、扣两次额度。
   */
  const 已消化地址问句 = useRef(false);
  useEffect(() => {
    const q0 = 地址栏.get("q");
    if (!q0 || 已消化地址问句.current) return;
    已消化地址问句.current = true;
    router.replace("/dashboard");
    submit(q0);
    // 只认挂载时地址上的那一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 排队的下一问：前一问一停（答完 / 出错 / 被打断）就自动发出去
  useEffect(() => {
    if (running || !queued) return;
    dequeueTurn(scope, queued.id);
    start(queued);
  }, [running, queued]);

  function submit(raw: string, opts: { queue?: boolean } = {}) {
    const typed = raw.trim();
    if (!typed) return;
    let question = typed;
    if (typed.startsWith("/")) {
      const c = COMMANDS.find((x) => x.cmd === typed.split(/\s+/)[0]);
      if (c?.cmd === "/clear") {
        turns.forEach((t) => clearJob(`home:${t.id}`));
        clearThread(scope);
        setQ("");
        return;
      }
      if (c?.cmd === "/board") {
        router.push("/overview");
        return;
      }
      if (c?.cmd === "/model") {
        // 点开选单本身就是选模型，这里只负责把它亮出来
        setQ("");
        document.querySelector<HTMLButtonElement>(".mp-btn")?.click();
        return;
      }
      if (!c) {
        setQ("");
        return;
      }
      question = c.question;
    }
    if (question.length < 2) return;
    // 正在答的时候再发：排队，不并发打模型
    const shouldQueue = opts.queue || Boolean(running);
    const turn = addTurn(scope, {
      question,
      kind: "ask",
      queued: shouldQueue,
      files: files.length ? files.map((f) => ({ name: f.name, text: f.text })) : undefined,
    });
    set刚发的(turn.id);
    if (!shouldQueue) start(turn);
    setQ("");
    setFiles([]);
  }

  function stop() {
    if (running) cancelStream(`home:${running.id}`);
    taRef.current?.focus();
  }

  /**
   * 把输入框实测高度写进 --cli-composer-h，供 scroll-margin 和「贴着底部」判断用。
   * 它会随输入的文字长高（上限见 globals.css 里 .cli-input textarea 的 max-height），写死一个常数迟早对不上。
   */
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const 量 = () => document.documentElement.style.setProperty("--cli-composer-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    量();
    const ro = new ResizeObserver(量);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Esc：打断正在跑的那一问（页面任何地方按都行）。⌘K 聚焦在 AskBox 里，两页共用一份
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && running) cancelStream(`home:${running.id}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running]);

  const empty = turns.length === 0;
  const canSend = q.trim().length > 0;
  /** 输入框底下摆不摆那排建议问题：只在还没问过、且库里有东西的时候 */
  const 摆建议 = empty && !空库 && suggestions.length > 0 && 模式 === "宽";
  const 问这条 = (x: Suggestion) => submit(x.kind === "prep" ? "/prep" : x.kind === "recap" ? "/recap" : x.question);

  const 窄 = 模式 === "窄";

  return (
    <div className={`cli${empty ? " cli-empty" : ""}${窄 ? " cli-narrow" : ""}`}>
      <div className="cli-col">
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
            <StartCard />
          </motion.div>
        ) : empty ? (
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
                也可以直接问，或者让它记一笔、改状态、排计划——它给一张建议卡，你点确认才写入。输入 <kbd>/</kbd> 看命令，<kbd>⌘K</kbd> 回到输入框。
              </div>
            </div>
          </motion.div>
        ) : (
          <div className="cli-log">
            {turns.map((t) => (
              <TurnView
                key={t.id}
                turn={t}
                scrollOnMount={t.id === 刚发的}
                onRetry={() => {
                  clearJob(`home:${t.id}`);
                  if (running) dequeueTurn(scope, t.id);
                  start(t);
                }}
                onRemove={() => {
                  cancelStream(`home:${t.id}`);
                  clearJob(`home:${t.id}`);
                  removeTurn(scope, t.id);
                }}
                onAsk={(q) => submit(q)}
              />
            ))}
            <div ref={endRef} />
          </div>
        )}

        <div ref={composerRef} className={`cli-composer${empty ? "" : " cli-composer-sticky"}`}>
          <AskBox
            引用={taRef}
            value={q}
            onChange={(v) => {
              setQ(v);
              setCmdIdx(0);
            }}
            onSubmit={() => submit(cmdMatches.length ? cmdMatches[cmdIdx].cmd : q)}
            placeholder={running ? "正在回答… 再问会排队，Esc 打断" : `问一位${b.customer}，或问一个数`}
            栏左={<AskFiles files={files} onChange={setFiles} disabled={running != null} />}
            栏右={<ModelPicker options={models} value={model} />}
            上方={
              cmdMatches.length > 0 ? (
                <div className="cli-cmds">
                  {cmdMatches.map((c, i) => (
                    <div key={c.cmd} className={`cli-cmd${i === cmdIdx ? " cli-cmd-on" : ""}`} onMouseDown={() => submit(c.cmd)}>
                      <span className="cli-cmd-k">{c.cmd}</span>
                      <span className="cli-cmd-h">{c.hint}</span>
                    </div>
                  ))}
                </div>
              ) : null
            }
            发送={
              running ? (
                <Tooltip title="打断（Esc）">
                  <button type="button" className="cli-send cli-stop" onClick={stop} aria-label="打断">
                    <span className="cli-stop-sq" />
                  </button>
                </Tooltip>
              ) : (
                <Dropdown
                  trigger={["hover"]}
                  placement="topRight"
                  menu={{
                    items: [
                      { key: "send", label: <MenuRow label="发送" keys="↵" /> },
                      { key: "queue", label: <MenuRow label="排队，等上一问答完再发" keys="⌘↵" /> },
                    ],
                    onClick: ({ key }) => submit(q, { queue: key === "queue" }),
                  }}
                >
                  <button type="button" className="cli-send" onClick={() => submit(q)} disabled={!canSend} aria-label="发送">
                    <ArrowUpOutlined />
                  </button>
                </Dropdown>
              )
            }
            onKeyDown={(e) => {
              // 输入框空着、下面摆着建议问题时，↑↓ 在建议里走，回车发选中的那条
              if (!cmdMatches.length && !q && 摆建议 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                setSuggIdx((i) => {
                  const n = suggestions.length;
                  if (e.key === "ArrowDown") return i + 1 >= n ? 0 : i + 1;
                  return i <= 0 ? n - 1 : i - 1;
                });
                return;
              }
              if (cmdMatches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                setCmdIdx((i) => (i + (e.key === "ArrowDown" ? 1 : cmdMatches.length - 1)) % cmdMatches.length);
                return;
              }
              if (cmdMatches.length && e.key === "Tab") {
                e.preventDefault();
                setQ(cmdMatches[cmdIdx].cmd + " ");
                return;
              }
              // Ctrl+C（Codex 的习惯）：没选中文字时当打断用
              if (e.ctrlKey && e.key === "c" && running && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
                e.preventDefault();
                stop();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!cmdMatches.length && !q && suggIdx >= 0 && suggestions[suggIdx]) {
                  问这条(suggestions[suggIdx]);
                  setSuggIdx(-1);
                  return;
                }
                submit(cmdMatches.length ? cmdMatches[cmdIdx].cmd : q, { queue: e.metaKey || e.ctrlKey });
              }
            }}
          />

          {/* 4–6 个能直接点的具体问题，就摆在输入框底下——人的视线落在框上。
              ↑↓ 在这里面走，回车发选中的那条 */}
          {摆建议 && (
            <div className="cli-welcome-q">
              {suggestions.map((x, i) => (
                <button
                  key={x.label}
                  type="button"
                  className={`cli-q${i === suggIdx ? " cli-q-on" : ""}`}
                  onClick={() => 问这条(x)}
                >
                  {x.label}
                </button>
              ))}
            </div>
          )}

          <div className="cli-hints">
            <span>
              <kbd>Enter</kbd> 发送 · <kbd>Shift+Enter</kbd> 换行 · <kbd>/</kbd> 命令
              {running && (
                <>
                  {" · "}
                  <kbd>Esc</kbd> 打断 · <kbd>⌘↵</kbd> 排队
                </>
              )}
            </span>
            {/* 免费次数常驻显示。等横条弹出来才知道，人已经在问第五句了 */}
            {aiQuota && (
              <span className={`cli-quota${aiQuota.还剩 === 0 ? " cli-quota-out" : aiQuota.还剩 <= 2 ? " cli-quota-low" : ""}`}>
                免费提问 {aiQuota.还剩}/{aiQuota.上限}
              </span>
            )}
            <span style={{ flex: 1 }} />
            {!empty && suggestions.slice(0, 3).map((x) => (
              <button key={x.label} type="button" className="cli-sugg" onClick={() => 问这条(x)}>
                {x.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MenuRow({ label, keys }: { label: string; keys: string }) {
  return (
    <span className="cli-menu-row">
      <span>{label}</span>
      <kbd>{keys}</kbd>
    </span>
  );
}


function whenLabel(at: number): string {
  const d = dayjs(at);
  const m = dayjs().diff(d, "minute");
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  return d.isToday() ? d.format("HH:mm") : d.format("MM-DD HH:mm");
}

/**
 * 自动滚动的两条规矩。
 *
 * 之前的写法是 turn.scrollIntoView({ block: "end" })，把轮次底边对齐到**视口**底边。
 * 但输入框是 position:sticky bottom:0、实测 104px 高，正好盖住视口最底下那一条——
 * 于是每次发送，刚发出的问题（top 404）就落在输入框（top 396）后面，
 * 正在生成的回答也永远差最后一百多像素露不出来。页面还会停在离真正底部 130px 的地方。
 *
 * 所以：
 *   1. 所有滚动目标都留出输入框的高度（--cli-composer-h，由 ResizeObserver 实时量）
 *   2. 只在用户已经贴着底部时才跟随。答案还在流的时候人往上翻是常事，
 *      不判断就会把他一次次拽回来
 */
function composerH(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--cli-composer-h");
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 104;
}

/**
 * 这一屏在**哪个容器里**滚。
 *
 * 宽模式（首页）：聊天就是整页，容器是文档，返回 null。
 * 窄模式（右侧面板）：容器是 `.dock-body`——**必须认出它来**，否则
 * `scrollIntoView` 会把祖先链上每一个滚动容器都滚一遍，文档也在那条链上，
 * 于是在功能页问一句，左边那一整栏跟着往下跑了 588px
 * （2026-09-19 实测：发送前 scrollTop=0，发送后 588.5）。
 * 对话是对话，正文不该动。
 */
function 滚动容器(el: HTMLElement | null): HTMLElement | null {
  return el?.closest<HTMLElement>(".dock-body") ?? null;
}

/**
 * 还在不在「跟着答案往下看」的状态。
 *
 * **不能靠位置推断。** 原来的判据是「离底部够近就跟」，在整页滚动下成立
 * （页面一路跟着答案走，自然一直贴着底）。但在面板那个容器里不成立：
 * 只要有一次没跟上，容器就永远显得「离底部很远」，从此再也不跟——
 * 答案在看不见的地方一路生成完（2026-09-19 改容器滚动时当场踩到）。
 *
 * 所以改成显式的：**开始一轮就跟，人自己滚一下就停。**
 * 人往上翻是想看前面的东西，那时再把他拽回来才是真的烦。
 */
function 贴着底部(容器: HTMLElement | null): boolean {
  const 余量 = composerH() + 90;
  if (容器) return 容器.scrollHeight - 容器.scrollTop - 容器.clientHeight < 余量;
  return document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 余量;
}

/** 把这一轮滚到容器顶部 / 底部。容器为 null 时才退回 scrollIntoView（那时滚的就是文档） */
function 滚到(el: HTMLElement | null, 位置: "start" | "end") {
  if (!el) return;
  const 容器 = 滚动容器(el);
  if (!容器) {
    el.scrollIntoView({ behavior: "smooth", block: 位置 });
    return;
  }
  if (位置 === "end") {
    容器.scrollTo({ top: 容器.scrollHeight, behavior: "smooth" });
    return;
  }
  const 相对 = el.getBoundingClientRect().top - 容器.getBoundingClientRect().top + 容器.scrollTop;
  容器.scrollTo({ top: Math.max(0, 相对), behavior: "smooth" });
}

function TurnView({ turn, onRetry, onRemove, onAsk, scrollOnMount }: { turn: Turn; onRetry: () => void; onRemove: () => void; onAsk: (q: string) => void; scrollOnMount: boolean }) {
  const b = useBusiness();
  const { message } = App.useApp();
  const job = useJob<StreamJob<AgentAnswer>>(`home:${turn.id}`);
  const ref = useRef<HTMLDivElement>(null);
  const done = job?.status === "done" || job?.status === "error";
  const [elapsed, setElapsed] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (done || !job) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - job.startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [done, job]);
  // 刚发出的这一问：把问题滚到视口顶部，答案往下面的空白里生成。
  // 不能用 block:"end"——那会把它顶到输入框后面，人看不见自己刚发的话。
  useEffect(() => {
    if (!scrollOnMount) return;
    滚到(ref.current, "start");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
    流式跟随。整页滚动（首页）时沿用老判据「离底部够近就跟」；
    面板那个容器里改用显式开关——见 贴着底部 上面那段：
    位置推断在容器里会一次失手就永久失效。
  */
  const 跟随中 = useRef(true);
  useEffect(() => {
    const 容器 = 滚动容器(ref.current);
    if (!容器) return;
    // 人自己滚一下就停下跟随；滚回底部再继续
    const on = () => {
      跟随中.current = 容器.scrollHeight - 容器.scrollTop - 容器.clientHeight < composerH() + 90;
    };
    容器.addEventListener("wheel", on, { passive: true });
    容器.addEventListener("touchmove", on, { passive: true });
    return () => {
      容器.removeEventListener("wheel", on);
      容器.removeEventListener("touchmove", on);
    };
  }, []);
  useEffect(() => {
    const 容器 = 滚动容器(ref.current);
    if (容器 ? !跟随中.current : !贴着底部(null)) return;
    滚到(ref.current, "end");
  }, [job?.value?.text?.length, done]);

  const interrupted = job?.status === "error" && job.error === "已取消";
  const steps: StepEvent[] = (job?.value?.steps ?? [])
    .filter((s) => s.id !== "answer")
    .map((s) => (job?.status === "error" && s.status === "running" ? { ...s, status: interrupted ? ("done" as const) : ("error" as const), detail: interrupted ? "被打断" : s.detail } : s));
  const text = job?.value?.text ?? job?.value?.answer?.text ?? "";
  const answer = job?.status === "done" ? job.value?.answer : undefined;
  const writing = job?.value?.steps?.some((s) => s.id === "answer" && s.status === "running");
  const thinking = Boolean(job) && !done && !text;
  const ms = job?.value?.ms;
  const showRows = !done || open;
  /** 这一轮答完之后能接着问什么。最多三条，全部由这次回答提到的人生成 */
  const 追问 = !answer
    ? []
    : [
        ...answer.customers.slice(0, 2).map((c) => `${c.name}这边下一步该做什么`),
        ...(answer.customers.length > 0 && answer.proposals.length === 0 ? [`帮我给${answer.customers[0].name}排一次跟进`] : []),
      ].slice(0, 3);

  return (
    <div ref={ref} className="cli-turn">
      <div className="cli-user">
        <div className="cli-bubble">{turn.question}</div>
      </div>

      {turn.queued && (
        <div className="cli-step">
          <span className="cli-dot cli-dot-idle" />
          <span className="cli-step-l">排队中，等上一问答完</span>
          <button type="button" className="cli-link" onClick={onRemove}>
            取消
          </button>
        </div>
      )}

      {steps.length > 0 && done && (
        <button type="button" className={`cli-sum${open ? " cli-sum-open" : ""}`} onClick={() => setOpen((v) => !v)}>
          <span>{summarizeSteps(steps, b.customer)}</span>
          {ms ? <span className="cli-sum-ms">{(ms / 1000).toFixed(1)}s</span> : null}
          <RightOutlined className="cli-sum-chev" />
        </button>
      )}
      {showRows &&
        steps.map((s) => (
          <div key={s.id} className={`cli-step cli-step-${s.status}`}>
            <span className="cli-dot" />
            <span className="cli-step-b">
              <span className="cli-step-l">{s.label}</span>
              {s.detail && <span className="cli-step-d">{s.detail}</span>}
              {open && s.thought && <span className="cli-step-t">{s.thought}</span>}
            </span>
          </div>
        ))}
      {thinking && (
        <div className="cli-step cli-step-running">
          <span className="cli-dot" />
          <span className="cli-step-l cli-think">
            {writing ? "在写" : "在想"}
            <span className="cli-think-dots">
              <i>.</i>
              <i>.</i>
              <i>.</i>
            </span>
          </span>
          <span className="cli-step-d">{elapsed}s · Esc 打断</span>
        </div>
      )}

      {text && (
        <div className="cli-a">
          <Markdown text={text} records={answer?.records ?? job?.value?.answer?.records ?? []} />
          {!done && <span className="cli-caret" />}
        </div>
      )}

      {interrupted && (
        <div className="cli-stopped">
          <span className="cli-stop-mark" />
          已中断
          <button type="button" className="cli-link" onClick={onRetry}>
            重试
          </button>
        </div>
      )}
      {job?.status === "error" && !interrupted && (
        <div className="cli-err">
          {job.error}
          <button type="button" className="cli-link" onClick={onRetry}>
            重试
          </button>
        </div>
      )}

      {answer && answer.proposals?.length > 0 && (
        <div className="prop-list">
          {answer.proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
        </div>
      )}

      {answer && answer.customers.length > 0 && (
        <div className="cli-card">
          <div className="cli-card-h">
            涉及 {answer.customers.length} 位{b.customer}
          </div>
          {answer.customers.slice(0, 5).map((c) => (
            <CustomerRow key={c.id} customer={c} />
          ))}
        </div>
      )}

      {/*
        回答后面跟着下一步（照 eigent 那条：结果 → 简报 → 建议的后续）。
        追问只从**这次回答真的提到的人**里长出来，不凭空造两个问题挂在那儿——
        一个点不出东西的追问比没有追问更糟。
      */}
      {done && 追问.length > 0 && (
        <div className="cli-next">
          {追问.map((q) => (
            <button key={q} type="button" className="cli-q" onClick={() => onAsk(q)}>
              {q}
            </button>
          ))}
        </div>
      )}

      {done && (
        <div className="cli-bar">
          {answer && (
            <Tooltip title="复制回答">
              <button
                type="button"
                className="cli-ic"
                aria-label="复制回答"
                onClick={async () => {
                  await navigator.clipboard.writeText(answer.text);
                  message.success("已复制");
                }}
              >
                <CopyOutlined />
              </button>
            </Tooltip>
          )}
          <Tooltip title="重新回答">
            <button type="button" className="cli-ic" aria-label="重新回答" onClick={onRetry}>
              <ReloadOutlined />
            </button>
          </Tooltip>
          <Tooltip title="移除这一轮">
            <button type="button" className="cli-ic" aria-label="移除这一轮" onClick={onRemove}>
              <CloseOutlined />
            </button>
          </Tooltip>
          <span className="cli-bar-t">{whenLabel(turn.at)}</span>
        </div>
      )}
    </div>
  );
}

/** 卡片里的一行：客户名、状态、动作；草稿就地展开，与记录页、盯盘、雷达共用同一份 */
function CustomerRow({ customer }: { customer: { id: string; name: string; followStatus: string } }) {
  const b = useBusiness();
  const { message } = App.useApp();
  const wakeup = useJob<string>(`draft:wakeup:${customer.id}`);
  const invite = useJob<string>(`draft:invite:${customer.id}`);
  const run = (kind: "wakeup" | "invite") =>
    runJob(`draft:${kind}:${customer.id}`, async () => {
      const res = kind === "wakeup" ? await draftWakeup({ customerId: customer.id, reason: "从首页发起" }) : await draftInvite({ customerId: customer.id });
      return res.ok ? { ok: true, value: res.message } : res;
    });
  return (
    <div className="cli-card-row">
      <div className="cli-card-main">
        <span className="cli-card-name">{customer.name}</span>
        {customer.followStatus && <span className="cli-card-st">{customer.followStatus}</span>}
        <span style={{ flex: 1 }} />
        <button type="button" className="cli-link" onClick={() => run("wakeup")} disabled={wakeup?.status === "loading"}>
          {wakeup?.status === "loading" ? "起草中…" : "起草跟进话术"}
        </button>
        {customer.followStatus === "已签约" && (
          <button type="button" className="cli-link" onClick={() => run("invite")} disabled={invite?.status === "loading"}>
            {invite?.status === "loading" ? "起草中…" : "起草转介绍邀请"}
          </button>
        )}
        <Link href={`/customers/${customer.id}`} className="cli-link cli-card-open">
          打开 <RightOutlined style={{ fontSize: 10 }} />
        </Link>
      </div>
      {[
        { kind: "wakeup" as const, job: wakeup },
        { kind: "invite" as const, job: invite },
      ].map(({ kind, job }) =>
        job?.status === "done" && job.value ? (
          <div key={kind} className="cli-draft">
            <div>{job.value}</div>
            <div>
              <button
                type="button"
                className="cli-link"
                onClick={async () => {
                  await navigator.clipboard.writeText(job.value!);
                  message.success(`已复制，去微信发给${b.customer}吧`);
                }}
              >
                复制
              </button>
              <button type="button" className="cli-link" onClick={() => clearJob(`draft:${kind}:${customer.id}`)}>
                收起
              </button>
            </div>
          </div>
        ) : job?.status === "error" ? (
          <div key={kind} className="cli-err">
            {job.error}
          </div>
        ) : null,
      )}
    </div>
  );
}
