"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App } from "antd";
import { motion } from "motion/react";
import type { BriefRecord } from "@/lib/ai-draft";
import { draftWakeup } from "./ai";
import { draftInvite } from "../channels/ai";
import Markdown from "@/components/Markdown";
import { useBusiness } from "@/lib/business-client";
import { runJob, useJob, clearJob, useRunningKey } from "@/lib/ai-jobs";
import { runStream, cancelStream, type StreamJob } from "@/lib/ai-stream";
import { addTurn, clearThread, removeTurn, useThread, type Turn } from "@/lib/home-thread";
import type { StepEvent } from "@/lib/ai-steps";

export type Suggestion = { label: string; question: string; kind?: "ask" | "prep" | "recap" };

type AgentAnswer = { text: string; records: BriefRecord[]; customers: { id: string; name: string; followStatus: string }[] };

/** 斜杠命令：像 Claude Code 那样，输入 / 弹一张单子 */
const COMMANDS: { cmd: string; hint: string; question: string }[] = [
  { cmd: "/prep", hint: "准备下次跟进：找我最该联系的那位，读完记录给建议", question: "看一下我未完成的跟进计划，挑最该准备的那位，读完记录告诉我这次该谈什么" },
  { cmd: "/recap", hint: "回顾上次沟通：上次跟的那位聊到哪了", question: "找我最近一次跟进的那位，读记录，告诉我上次聊到哪、有什么没接住" },
  { cmd: "/watch", hint: "盯盘：正在被遗忘的人，各自该从哪接上", question: "看盯盘清单，对前几位各给一句现在该从哪接上" },
  { cmd: "/board", hint: "打开数据看板", question: "" },
  { cmd: "/clear", hint: "清空这一屏", question: "" },
];

/**
 * 首页 = 一个命令行式的对话面（照 Claude Code / Codex 的交互）：
 *   › 你的问题                       ← 提示行
 *   ● search_customers(陈同学)  找到 1 位   ← 工具调用一行一条，跑着的时候点在呼吸
 *   ● get_customer(…)  3 条跟进 · 2 段原文
 *   （回答逐字流出，Markdown，句末 [n] 是引用的记录）
 * 底下是输入框：Enter 发送，Shift+Enter 换行，/ 出命令单，Esc 取消正在跑的那一问。
 * 背后是一个 agent 循环：模型自己决定读谁、查什么，工具全部只读。
 */
export default function HomeChat({ userName, suggestions, context }: { userName: string; suggestions: Suggestion[]; context: string }) {
  const b = useBusiness();
  const router = useRouter();
  const turns = useThread();
  const [q, setQ] = useState("");
  const [cmdIdx, setCmdIdx] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
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
  const showCmds = q.startsWith("/") && !q.includes(" ");
  const cmdMatches = showCmds ? COMMANDS.filter((c) => c.cmd.startsWith(q.trim())) : [];

  function start(turn: Turn) {
    runStream<AgentAnswer>(`home:${turn.id}`, { mode: "agent", question: turn.question });
  }

  function submit(raw: string) {
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
      if (!c) {
        setQ("");
        return;
      }
      question = c.question;
    }
    if (question.length < 2) return;
    const turn = addTurn({ question, kind: "ask" });
    start(turn);
    setQ("");
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length]);

  // Esc：取消正在跑的那一问；焦点回到输入框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && running) cancelStream(`home:${running.id}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running]);

  const empty = turns.length === 0;

  return (
    <div className={`cli${empty ? " cli-empty" : ""}`}>
      <div className="cli-col">
        {empty ? (
          <motion.div className="cli-welcome" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
            <div className="cli-welcome-t">
              {greet}，{userName}。
            </div>
            <div className="cli-welcome-s">{context}</div>
            <div className="cli-welcome-hints">
              <div>直接输入问题，比如「陈同学还能怎么推进」「各跟进状态各有多少{b.customer}」</div>
              <div>
                输入 <kbd>/</kbd> 看命令：{COMMANDS.map((c) => c.cmd).join("  ")}
              </div>
            </div>
          </motion.div>
        ) : (
          <div className="cli-log">
            {turns.map((t) => (
              <TurnView
                key={t.id}
                turn={t}
                onRetry={() => {
                  clearJob(`home:${t.id}`);
                  start(t);
                }}
                onRemove={() => {
                  clearJob(`home:${t.id}`);
                  removeTurn(t.id);
                }}
              />
            ))}
            <div ref={endRef} />
          </div>
        )}

        <div className={`cli-composer${empty ? "" : " cli-composer-sticky"}`}>
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
              maxLength={300}
              placeholder={running ? "正在回答… Esc 取消" : `问一位${b.customer}，或问一个数`}
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
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(cmdMatches.length ? cmdMatches[cmdIdx].cmd : q);
                  if (taRef.current) taRef.current.style.height = "auto";
                }
              }}
            />
          </div>
          <div className="cli-hints">
            <span>
              <kbd>Enter</kbd> 发送 · <kbd>Shift+Enter</kbd> 换行 · <kbd>/</kbd> 命令{running ? " · " : ""}
              {running && (
                <>
                  <kbd>Esc</kbd> 取消
                </>
              )}
            </span>
            <span style={{ flex: 1 }} />
            {suggestions.slice(0, 3).map((s) => (
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

function TurnView({ turn, onRetry, onRemove }: { turn: Turn; onRetry: () => void; onRemove: () => void }) {
  const b = useBusiness();
  const job = useJob<StreamJob<AgentAnswer>>(`home:${turn.id}`);
  const ref = useRef<HTMLDivElement>(null);
  const done = job?.status === "done" || job?.status === "error";
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (done) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - (job?.startedAt ?? Date.now())) / 1000)), 1000);
    return () => clearInterval(t);
  }, [done, job?.startedAt]);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [job?.value?.text?.length, done]);

  const steps: StepEvent[] = (job?.value?.steps ?? []).map((s) => (job?.status === "error" && s.status === "running" ? { ...s, status: "error" as const } : s));
  const text = job?.value?.text ?? job?.value?.answer?.text ?? "";
  const answer = job?.status === "done" ? job.value?.answer : undefined;
  const thinking = !done && !text;

  return (
    <div ref={ref} className="cli-turn">
      <div className="cli-q">
        <span className="cli-prompt">›</span>
        <span className="cli-q-t">{turn.question}</span>
        <button type="button" className="cli-x" onClick={onRemove} aria-label="移除">
          ×
        </button>
      </div>

      {steps.map((s) => (
        <div key={s.id} className={`cli-step cli-step-${s.status}`}>
          <span className="cli-dot" />
          <span className="cli-step-l">{s.label}</span>
          {s.detail && <span className="cli-step-d">{s.detail}</span>}
        </div>
      ))}
      {thinking && (
        <div className="cli-step cli-step-running">
          <span className="cli-dot" />
          <span className="cli-step-l cli-think">
            {steps.length === 0 ? "在想" : "在写"}
            <span className="cli-think-dots">
              <i>.</i>
              <i>.</i>
              <i>.</i>
            </span>
          </span>
          <span className="cli-step-d">{elapsed}s · Esc 取消</span>
        </div>
      )}

      {text && (
        <div className="cli-a">
          <Markdown text={text} records={answer?.records ?? job?.value?.answer?.records ?? []} />
          {!done && <span className="cli-caret" />}
        </div>
      )}

      {job?.status === "error" && (
        <div className="cli-err">
          {job.error}
          <button type="button" className="cli-link" onClick={onRetry}>
            重试
          </button>
        </div>
      )}

      {answer && answer.customers.length > 0 && (
        <div className="cli-actions">
          {answer.customers.slice(0, 3).map((c) => (
            <CustomerActions key={c.id} customer={c} label={answer.customers.length > 1 ? c.name : undefined} />
          ))}
        </div>
      )}
      {done && job?.value?.ms ? <div className="cli-meta">{(job.value.ms / 1000).toFixed(1)}s · {steps.filter((s) => s.id.startsWith("tool")).length} 次读取</div> : null}
      {answer && (
        <div className="cli-foot">
          只起草，不落库。{answer.records.length ? "圆标是引用的记录。" : ""}
          {b.customer}
          页里的信息以记录为准。
        </div>
      )}
    </div>
  );
}

/** 答完给动作：打开记录页 / 起草话术 / 邀请，草稿就地展开，与记录页、盯盘、雷达共用同一份 */
function CustomerActions({ customer, label }: { customer: { id: string; name: string; followStatus: string }; label?: string }) {
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
    <div className="cli-action-row">
      {label && <span className="cli-action-name">{label}</span>}
      <Link href={`/customers/${customer.id}`} className="cli-link">
        打开{b.customer}页
      </Link>
      <button type="button" className="cli-link" onClick={() => run("wakeup")} disabled={wakeup?.status === "loading"}>
        {wakeup?.status === "loading" ? "起草中…" : "起草跟进话术"}
      </button>
      {customer.followStatus === "已签约" && (
        <button type="button" className="cli-link" onClick={() => run("invite")} disabled={invite?.status === "loading"}>
          {invite?.status === "loading" ? "起草中…" : "起草转介绍邀请"}
        </button>
      )}
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
