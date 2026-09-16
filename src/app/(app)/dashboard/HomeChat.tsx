"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Dropdown, Tooltip } from "antd";
import { ArrowUpOutlined, CopyOutlined, ReloadOutlined, CloseOutlined, RightOutlined } from "@ant-design/icons";
import { motion } from "motion/react";
import type { BriefRecord } from "@/lib/ai-draft";
import ProposalCard from "@/components/ProposalCard";
import ModelPicker, { useModel, setModel } from "@/components/ModelPicker";
import type { ModelOption } from "@/lib/llm";
import type { Proposal } from "@/lib/agent/proposals";
import { draftWakeup } from "./ai";
import { draftInvite } from "../channels/ai";
import Markdown from "@/components/Markdown";
import { useBusiness } from "@/lib/business-client";
import { clearJob, getJob, runJob, useJob, useRunningKey } from "@/lib/ai-jobs";
import { runStream, cancelStream, type StreamJob } from "@/lib/ai-stream";
import { addTurn, clearThread, dequeueTurn, removeTurn, useThread, type Turn } from "@/lib/home-thread";
import { DemoDataButton } from "@/components/EmptyState";
import type { StepEvent } from "@/lib/ai-steps";
import { dayjs } from "@/lib/utils";

export type Suggestion = { label: string; question: string; kind?: "ask" | "prep" | "recap" };

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
export default function HomeChat({ userName, suggestions, context, models, aiQuota }: { userName: string; suggestions: Suggestion[]; context: string; models: ModelOption[]; aiQuota?: { 上限: number; 还剩: number } | null }) {
  const b = useBusiness();
  const router = useRouter();
  const turns = useThread();
  const model = useModel(models);
  const [q, setQ] = useState("");
  const [cmdIdx, setCmdIdx] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  /** 刚发出去的那一问。只有它会在挂载时把自己滚到视口顶部，翻历史不该乱跳 */
  const [刚发的, set刚发的] = useState<string | null>(null);
  const greet = useSyncExternalStore(
    () => () => {},
    () => {
      const h = new Date().getHours();
      return h < 5 ? "夜深了" : h < 12 ? "早上好" : h < 18 ? "下午好" : "晚上好";
    },
    () => "你好",
  );

  const runningKey = useRunningKey(turns.map((t) => `home:${t.id}`));
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
    runStream<AgentAnswer>(`home:${turn.id}`, { mode: "agent", question: turn.question, model, history: 收集上下文(turn.id) });
  }

  // 排队的下一问：前一问一停（答完 / 出错 / 被打断）就自动发出去
  useEffect(() => {
    if (running || !queued) return;
    dequeueTurn(queued.id);
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
        clearThread();
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
    const turn = addTurn({ question, kind: "ask", queued: shouldQueue });
    set刚发的(turn.id);
    if (!shouldQueue) start(turn);
    setQ("");
    if (taRef.current) taRef.current.style.height = "auto";
  }

  function stop() {
    if (running) cancelStream(`home:${running.id}`);
    taRef.current?.focus();
  }

  /**
   * 把输入框实测高度写进 --cli-composer-h，供 scroll-margin 和「贴着底部」判断用。
   * 它会随输入的文字长高（最多 140px），写死一个常数迟早对不上。
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

  // Esc：打断正在跑的那一问（页面任何地方按都行）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && running) cancelStream(`home:${running.id}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running]);

  const empty = turns.length === 0;
  const canSend = q.trim().length > 0;

  return (
    <div className={`cli${empty ? " cli-empty" : ""}`}>
      <div className="cli-col">
        {empty ? (
          <motion.div className="cli-welcome" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
            <div className="cli-welcome-t">
              {greet}，{userName}。
            </div>
            <div className="cli-welcome-s">{context}</div>
            {/*
              空首页上最该给的是「能直接点的问题」，不是用法说明。
              原来这里是三行说明、建议问题缩在右下角两个灰字里——那是给已经会用的人看的。
              现在反过来：问题摆成一排能点的，说明压成一行。
            */}
            {suggestions.length > 0 && (
              <div className="cli-welcome-q">
                {suggestions.map((s) => (
                  <button key={s.label} type="button" className="cli-q" onClick={() => submit(s.kind === "prep" ? "/prep" : s.kind === "recap" ? "/recap" : s.question)}>
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            <div className="cli-welcome-hints">
              <div>
                也可以直接问，或者让它记一笔、改状态、排计划——它给一张建议卡，你点确认才写入。输入 <kbd>/</kbd> 看命令。
              </div>
            </div>
            <DemoDataButton />
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
                  if (running) dequeueTurn(t.id);
                  start(t);
                }}
                onRemove={() => {
                  cancelStream(`home:${t.id}`);
                  clearJob(`home:${t.id}`);
                  removeTurn(t.id);
                }}
              />
            ))}
            <div ref={endRef} />
          </div>
        )}

        <div ref={composerRef} className={`cli-composer${empty ? "" : " cli-composer-sticky"}`}>
          {cmdMatches.length > 0 && (
            <div className="cli-cmds">
              {cmdMatches.map((c, i) => (
                <div key={c.cmd} className={`cli-cmd${i === cmdIdx ? " cli-cmd-on" : ""}`} onMouseDown={() => submit(c.cmd)}>
                  <span className="cli-cmd-k">{c.cmd}</span>
                  <span className="cli-cmd-h">{c.hint}</span>
                </div>
              ))}
            </div>
          )}
          <div className="cli-input">
            <span className="cli-prompt">›</span>
            <textarea
              ref={taRef}
              value={q}
              rows={1}
              maxLength={1000}
              placeholder={running ? "正在回答… 再问会排队，Esc 打断" : `问一位${b.customer}，或问一个数`}
              onChange={(e) => {
                setQ(e.target.value);
                setCmdIdx(0);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
              }}
              onKeyDown={(e) => {
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
                  submit(cmdMatches.length ? cmdMatches[cmdIdx].cmd : q, { queue: e.metaKey || e.ctrlKey });
                }
              }}
            />
            {running ? (
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
            )}
          </div>
          <div className="cli-hints">
            <ModelPicker options={models} value={model} />
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
            {!empty && suggestions.slice(0, 3).map((s) => (
              <button key={s.label} type="button" className="cli-sugg" onClick={() => submit(s.kind === "prep" ? "/prep" : s.kind === "recap" ? "/recap" : s.question)}>
                {s.label}
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

/** 把工具调用折成一句人话：「读了 1 位客户，查了 1 个数」 */
function summarizeSteps(steps: StepEvent[], customer: string): string {
  const n = (prefix: string) => steps.filter((s) => s.id.startsWith("tool") && s.label.startsWith(prefix)).length;
  const parts: string[] = [];
  const search = n("search_customers");
  const read = n("get_customer");
  const metric = n("query_metric");
  if (search) parts.push(`搜了 ${search} 次`);
  if (read) parts.push(`读了 ${read} 位${customer}的记录`);
  if (metric) parts.push(`查了 ${metric} 个数`);
  if (n("get_watchlist")) parts.push("看了盯盘");
  if (n("get_my_plans")) parts.push("看了我的计划");
  return parts.join("，") || "没有读取任何记录";
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

function 贴着底部(): boolean {
  const 余量 = composerH() + 90;
  return document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 余量;
}

function TurnView({ turn, onRetry, onRemove, scrollOnMount }: { turn: Turn; onRetry: () => void; onRemove: () => void; scrollOnMount: boolean }) {
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
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 流式跟随：只在人已经贴着底部时才动
  useEffect(() => {
    if (!贴着底部()) return;
    ref.current?.scrollIntoView({ behavior: "smooth", block: "end" });
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
