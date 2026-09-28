"use client";

import type { 页面范围 } from "@/lib/ai-context-page";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Dropdown, Tooltip } from "antd";
import { ArrowUpOutlined, SnippetsOutlined } from "@ant-design/icons";
import { motion } from "motion/react";
import ModelPicker, { useModel } from "@/components/ModelPicker";
import AskFiles, { type 附件 } from "@/components/AskFiles";
import ImportDrawer from "../customers/ImportDrawer";
import type { ModelOption } from "@/lib/llm";
import { useBusiness } from "@/lib/business-client";
import { clearJob, getJob, useRunningKey } from "@/lib/ai-jobs";
import { runStream, cancelStream, type StreamJob } from "@/lib/ai-stream";
import { addTurn, clearThread, dequeueTurn, removeTurn, useThread, 认领对话, 认落, 当前对话, 首页屏, type Turn } from "@/lib/home-thread";
import { 载入历史, type AgentAnswer, type 历史消息 } from "@/lib/thread-history";
import { 落一轮 } from "./threads";
import AskBox from "@/components/AskBox";
import StartCard from "./StartCard";
import TurnView from "./TurnView";
import Signals from "./Signals";
import { AiRemaining } from "@/components/AiCost";
import { Esc归别人 } from "@/lib/esc";

export type Suggestion = { label: string; question: string; kind?: "ask" | "prep" | "recap" };

/** 斜杠命令：像 Claude Code 那样，输入 / 弹一张单子 */
const COMMANDS: { cmd: string; hint: string; question: string }[] = [
  { cmd: "/prep", hint: "准备下次跟进：找我最该联系的那位，读完记录给建议", question: "看一下我未完成的跟进计划，挑最该准备的那位，读完记录告诉我这次该谈什么" },
  { cmd: "/recap", hint: "回顾上次沟通：上次跟的那位聊到哪了", question: "找我最近一次跟进的那位，读记录，告诉我上次聊到哪、有什么没接住" },
  { cmd: "/watch", hint: "盯盘：正在被遗忘的人，各自该从哪接上", question: "看盯盘清单，对前几位各给一句现在该从哪接上" },
  { cmd: "/model", hint: "换个模型", question: "" },
  // 左栏那一项叫「数据」，这里也叫「数据」（审查 D3）
  { cmd: "/board", hint: "打开数据", question: "" },
  { cmd: "/clear", hint: "清空这一屏", question: "" },
];

/** 只有一个模型时 /model 按下去什么也不会发生（没有选单可开），就不列出来（审查 D3） */
function 命令表(几个模型: number) {
  return 几个模型 > 1 ? COMMANDS : COMMANDS.filter((c) => c.cmd !== "/model");
}

/**
 * 首页 = 一个对话面，交互照 Claude Code / Codex：
 *   一轮 = 右侧你的问题气泡 → 过程（工具调用一行一条，答完折成一句摘要，点开看）→ 逐字流出的回答
 *          → 涉及的客户卡片（打开 / 起草）→ 底部一排小图标（复制 / 重试 / 移除）和用时
 *   输入框：Enter 发送；正在答时 Enter 或 ⌘↵ 排队，等它答完自动发；Shift+Enter 换行；/ 出命令单
 *   打断：Esc、Ctrl+C，或点右侧的停止键；中断后留一行「已中断」，已流出的字不丢
 * 背后是一个 agent 循环：模型自己决定读谁、查什么，工具全部只读。
 */
export type 首页信号 = { 逾期: number; 高意向: number; 本月签约: number; 高意向标签: string };

export default function HomeChat({ 会话, userName, suggestions, context, models, 空库, 信号, 模式 = "宽", 上下文提示, 上下文范围, scope = 首页屏, 标题前缀 }: {
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
}) {
  const b = useBusiness();
  const router = useRouter();
  const turns = useThread(scope);
  const 地址栏 = useSearchParams();
  const model = useModel(models);
  /** 这一问要带的文件。发出去就清空——它属于那一问，不属于这个输入框 */
  const [files, setFiles] = useState<附件[]>([]);

  /*
    ── 粘一段聊天 ────────────────────────────────────────────
    主线是「粘一段 → 客户本自己长出来」，而这条路原来藏在客户页的导入抽屉里、
    还是第二个栏位。首页是人每天看的第一屏，入口就该在这儿（2026-09-21）。

    两个入口，都**不自动跑**：
      1. 框里粘进来一段像聊天的东西 → 输入框上方出一条提示，点了才走
      2. 框内左下角一个常驻的按钮 → 空着打开那扇门

    识别只看形状不看内容：**三行以上、六十字以上**才算。一句长问题不该被拦下来问
    「这是不是聊天记录」，而真正的聊天记录几乎不可能只有两行。
  */
  const [粘贴开着, set粘贴开着] = useState(false);
  /** 递给抽屉的全文。框里那份被 maxLength 截过，所以单独存一份 */
  const [粘来的, set粘来的] = useState("");
  /** 上方那条提示。人点了「当成问题问」就收起来，不再纠缠 */
  const [提示粘贴, set提示粘贴] = useState<{ 文本: string; 行数: number } | null>(null);

  function 认一下粘的是什么(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const 全文 = e.clipboardData?.getData("text") ?? "";
    const 行数 = 全文.split(/\r?\n/).filter((l) => l.trim()).length;
    if (行数 >= 3 && 全文.trim().length >= 60) set提示粘贴({ 文本: 全文, 行数 });
  }

  function 去粘贴(文本: string) {
    set粘来的(文本);
    set提示粘贴(null);
    set粘贴开着(true);
  }
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
    载入历史(scope, 会话);
  }, [会话]);

  /**
   * 答完一轮就落库。
   *
   * 在这儿做而不是在 runStream 里：那边是模块级的，不认识「当前是哪条对话」，
   * 也没有 router。先认领再发请求——这个 effect 会因为任务表变动跑好几次，
   * 不占位的话同一轮会落两遍。
   *
   * 占位用 认落()（模块级，一屏一份），**不是组件里的 ref**：把面板关掉再打开
   * 就是一次重挂载，而 turns 和答案都活在模块级，ref 里那道闸会跟着新实例清零，
   * 于是同一轮又落一遍——库里两条一模一样、连用时都一样的回答就是这么来的。
   */
  useEffect(() => {
    void (async () => {
      for (const t of turns) {
        const job = getJob<StreamJob<AgentAnswer>>(`home:${t.id}`);
        if (job?.status !== "done") continue;
        const 答 = (job.value?.answer?.text ?? job.value?.text ?? "").trim();
        if (!认落(scope, t.id)) continue;
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
          // 新建那条对话时记下「在哪一页问的」。标题前缀是给人看的，这个才是键
          scope,
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
  const 可用命令 = 命令表(models.length);
  const cmdMatches = showCmds ? 可用命令.filter((c) => c.cmd.startsWith(q.trim())) : [];
  /** 打了一个斜杠开头、却一条命令都对不上：就地说一句，不再回车后整行静默清空 */
  const 没这个命令 = showCmds && q.trim().length > 1 && cmdMatches.length === 0;

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
      { mode: "agent", question: turn.question, model, history: 收集上下文(turn.id), files: turn.files, pageContext: 上下文提示, pageScope: 上下文范围 },
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
      const c = 命令表(models.length).find((x) => x.cmd === typed.split(/\s+/)[0]);
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
      // 打错命令：原文留着，下面那行「没有这个命令」已经说了（审查 D3）。原来整行静默清空
      if (!c) return;
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

  /*
    Esc：打断正在跑的那一问（页面任何地方按都行）。⌘K 聚焦在 AskBox 里，两页共用一份。
    **只接没人要的那一下**（审查 M7）：关斜杠菜单、关跳转单、关日期选择、取消输入法拼音时，
    Esc 是给最上面那一层的，不该顺手把底下已经花了次数的回答打断。判断在 lib/esc.ts
  */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!running || Esc归别人(e)) return;
      cancelStream(`home:${running.id}`);
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
            onPaste={认一下粘的是什么}
            placeholder={running ? "正在回答… 再问会排队，Esc 打断" : `问一位${b.customer}，或问一个数`}
            栏左={
              <>
                <AskFiles files={files} onChange={setFiles} disabled={running != null} />
                {/*
                  主线入口。和加文件并排——都是「把外面的东西弄进来」，不是「问一句」。
                  **窄模式（右侧面板）只留图标**：380 宽那一条里还要塞模型选单和发送键，
                  带字的话三样挤在一起，而那一屏本来就是「在别的页面上顺手问一句」，
                  粘一段名单是首页的事。
                */}
                {/* 空库的欢迎态上那张「开始」卡已经有一颗「粘一段聊天」，这里不再摆第二颗（审查 D11） */}
                {!(empty && 空库 && 模式 === "宽") && (
                  <button
                    type="button"
                    className={`cli-tool${模式 === "宽" ? " cli-tool-t" : ""}`}
                    onClick={() => 去粘贴("")}
                    disabled={running != null}
                    title="把一段聊天记录粘进来，切成客户记录"
                  >
                    <SnippetsOutlined />
                    {模式 === "宽" && <span>粘一段聊天</span>}
                  </button>
                )}
              </>
            }
            栏右={<ModelPicker options={models} value={model} />}
            上方={
              提示粘贴 ? (
                /*
                  粘进来的像是一段聊天。**只提示，不自动跑**——这是 2026-09 拍板的那条
                  「AI 不自动跑」：一次切分要花一次 AI 次数，得他点。
                  右边那个「当成问题问」是给误判留的门，点一次就不再纠缠。
                */
                <div className="cli-paste">
                  <SnippetsOutlined />
                  <span className="cli-paste-t">
                    粘进来 {提示粘贴.行数} 行，像是一段记录——要切成{b.customer}吗？
                  </span>
                  <button type="button" className="cli-paste-y" onClick={() => 去粘贴(提示粘贴.文本)}>
                    切成{b.customer}
                  </button>
                  <button type="button" className="cli-paste-n" onClick={() => set提示粘贴(null)}>
                    当成问题问
                  </button>
                </div>
              ) : 没这个命令 ? (
                <div className="cli-cmds">
                  <div className="cli-cmd">
                    <span className="cli-cmd-k">{q.trim()}</span>
                    <span className="cli-cmd-h">没有这个命令。删掉「/」直接问，或者 Esc 清空</span>
                  </div>
                </div>
              ) : cmdMatches.length > 0 ? (
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
              // Esc 先关斜杠菜单 / 「没有这个命令」 / 粘贴提示这一层，不往下传去打断回答
              if (e.key === "Escape" && !e.nativeEvent.isComposing && (showCmds || 提示粘贴)) {
                e.preventDefault();
                if (提示粘贴) set提示粘贴(null);
                else setQ("");
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
            {/* 免费次数常驻显示。等横条弹出来才知道，人已经在问第五句了。
                每一问、每个建议问题都花 1 次，在这儿说一次，不在每个胶囊上挂角标（components/AiCost.tsx） */}
            <AiRemaining />
            <span style={{ flex: 1 }} />
            {!empty && suggestions.slice(0, 3).map((x) => (
              <button key={x.label} type="button" className="cli-sugg" onClick={() => 问这条(x)}>
                {x.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/*
        「粘一段聊天」那扇门。复用客户页那个导入抽屉——切分、两条核对（抓编造、抓漏人）、
        整批可撤销全在里面，主线入口不该另起一套规矩。
        aiEnabled 按「有没有模型可选」判：和右边那个模型选单同一个依据。
      */}
      <ImportDrawer
        open={粘贴开着}
        b={b}
        aiEnabled={models.length > 0}
        初始来路="文本"
        初始文本={粘来的}
        onClose={() => {
          set粘贴开着(false);
          set粘来的("");
        }}
        onDone={() => router.refresh()}
      />
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
