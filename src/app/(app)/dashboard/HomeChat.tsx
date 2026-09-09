"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Button, Input, Alert, App } from "antd";
import { ArrowUpOutlined, ArrowRightOutlined, ReloadOutlined, DeleteOutlined, BarChartOutlined, ThunderboltOutlined, CopyOutlined } from "@ant-design/icons";
import { motion, AnimatePresence } from "motion/react";
import type { HomeAnswer } from "./ask";
import { draftWakeup } from "./ai";
import { draftInvite } from "../channels/ai";
import AskDataResult from "../reports/AskDataResult";
import BriefBody from "../customers/[id]/BriefBody";
import AiTrace from "@/components/AiTrace";
import { useBusiness } from "@/lib/business-client";
import { runJob, useJob, clearJob } from "@/lib/ai-jobs";
import { runStream, type StreamJob } from "@/lib/ai-stream";
import { addTurn, clearThread, removeTurn, useThread, type Turn } from "@/lib/home-thread";

export type Suggestion = { label: string; question: string; kind?: "ask" | "prep" | "recap" };

/**
 * 首页 = 一个对话面。
 * 没有指标卡、没有图表——那些在「数据看板」。这里只有：问候、一个输入框、几枚按当前处境
 * 生成的建议 chip，以及一条随问随答的线程。每一问各自独立（不带上下文记忆），
 * 问到某位客户出简报，问到数字出图表，和记录页、报表页是同一套能力。
 * 每一问都能看见过程（识别问题 → 读取记录 → 生成），答案里的圆标是它引用的记录。
 */
export default function HomeChat({ userName, suggestions, context }: { userName: string; suggestions: Suggestion[]; context: string }) {
  const b = useBusiness();
  const turns = useThread();
  const [q, setQ] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const greet = useSyncExternalStore(
    () => () => {},
    () => {
      const h = new Date().getHours();
      return h < 5 ? "夜深了" : h < 12 ? "早上好" : h < 18 ? "下午好" : "晚上好";
    },
    () => "你好",
  );

  function start(turn: Turn) {
    runStream<HomeAnswer>(`home:${turn.id}`, turn.kind === "ask" ? { mode: "home", question: turn.question } : { mode: "quick", intent: turn.kind });
  }

  function submit(question: string, kind: Turn["kind"] = "ask") {
    const text = question.trim();
    if (kind === "ask" && text.length < 2) return;
    const turn = addTurn({ question: kind === "ask" ? text : question, kind });
    start(turn);
    setQ("");
  }

  // 新一轮出现时滚到底，像对话那样
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length]);

  const empty = turns.length === 0;

  return (
    <div className={`home${empty ? " home-empty" : ""}`}>
      <div className="home-col">
        <AnimatePresence initial={false}>
          {empty && (
            <motion.div key="hero" className="home-hero" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
              <div className="home-greet">
                {greet}，{userName}。
              </div>
              <div className="home-ctx">{context}</div>
            </motion.div>
          )}
        </AnimatePresence>

        {!empty && (
          <div className="home-thread">
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

        <div className={`home-composer${empty ? "" : " home-composer-sticky"}`}>
          <div className="home-input">
            <Input.TextArea
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoSize={{ minRows: 1, maxRows: 5 }}
              maxLength={300}
              placeholder={`问一位${b.customer}（"王同学还能怎么推进"），或问一个数（"这个月谁签得最多"）`}
              onPressEnter={(e) => {
                if (e.shiftKey) return;
                e.preventDefault();
                submit(q);
              }}
              variant="borderless"
            />
            <Button type="primary" shape="circle" icon={<ArrowUpOutlined />} disabled={q.trim().length < 2} onClick={() => submit(q)} aria-label="问" />
          </div>
          <div className="home-chips">
            {suggestions.map((s) => (
              <button key={s.label} type="button" className="home-chip" onClick={() => submit(s.question, s.kind ?? "ask")}>
                {s.label}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            {!empty && (
              <button
                type="button"
                className="home-chip home-chip-ghost"
                onClick={() => {
                  turns.forEach((t) => clearJob(`home:${t.id}`));
                  clearThread();
                }}
              >
                <DeleteOutlined /> 清空
              </button>
            )}
            <Link href="/overview" className="home-chip home-chip-ghost">
              <BarChartOutlined /> 数据看板
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function TurnView({ turn, onRetry, onRemove }: { turn: Turn; onRetry: () => void; onRemove: () => void }) {
  const b = useBusiness();
  const { message } = App.useApp();
  const job = useJob<StreamJob<HomeAnswer>>(`home:${turn.id}`);
  const ref = useRef<HTMLDivElement>(null);
  // 回答落地时把这一轮滚进视野：答案是异步来的，只在提问时滚一次不够
  const done = job?.status === "done" || job?.status === "error";
  useEffect(() => {
    if (done) ref.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [done]);
  const label = turn.kind === "prep" ? "准备下次跟进" : turn.kind === "recap" ? "回顾上次沟通" : turn.question;
  const answer = job?.status === "done" ? job.value?.answer : undefined;
  // 出错时把最后一个还在跑的步骤标红，一眼看出卡在哪
  const steps = (job?.value?.steps ?? []).map((s) => (job?.status === "error" && s.status === "running" ? { ...s, status: "error" as const } : s));

  return (
    <motion.div ref={ref} className="home-turn" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
      <div className="home-q">
        <span>{label}</span>
        <button type="button" className="home-turn-x" onClick={onRemove} aria-label="移除这一问">
          ×
        </button>
      </div>
      <div className="home-a">
        <AiTrace steps={steps} done={!!done} ms={job?.value?.ms} />
        {job?.status === "error" && (
          <Alert
            type="warning"
            showIcon
            title={job.error}
            style={{ marginTop: 8 }}
            action={
              <Button size="small" type="text" icon={<ReloadOutlined />} onClick={onRetry}>
                重试
              </Button>
            }
          />
        )}
        {answer && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} style={{ marginTop: 10 }}>
            {answer.kind === "customer" ? (
              <>
                <div className="home-a-head">
                  <span className="home-a-name">{answer.customerName}</span>
                  <Link href={`/customers/${answer.customerId}`} className="home-a-link">
                    打开{b.customer}页 <ArrowRightOutlined />
                  </Link>
                </div>
                <BriefBody brief={answer.brief} records={answer.records} />
                <CustomerActions customerId={answer.customerId} signed={answer.followStatus === "已签约"} />
              </>
            ) : (
              <>
                <div className="home-a-head">
                  <span className="home-a-name">问数据</span>
                  <a
                    className="home-a-link"
                    onClick={() => {
                      void navigator.clipboard.writeText(answer.result.answer);
                      message.success("已复制结论");
                    }}
                  >
                    复制结论
                  </a>
                </div>
                <AskDataResult result={answer.result} />
                <div className="home-actions">
                  <Link href="/reports" className="home-chip">
                    <BarChartOutlined /> 去数据复盘
                  </Link>
                </div>
              </>
            )}
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}

/** 答完给动作：起草话术 / 邀请，结果就地展开。key 与记录页、盯盘、雷达共用同一份草稿 */
function CustomerActions({ customerId, signed }: { customerId: string; signed: boolean }) {
  const b = useBusiness();
  const { message } = App.useApp();
  const wakeup = useJob<string>(`draft:wakeup:${customerId}`);
  const invite = useJob<string>(`draft:invite:${customerId}`);
  const run = (kind: "wakeup" | "invite") =>
    runJob(`draft:${kind}:${customerId}`, async () => {
      const res = kind === "wakeup" ? await draftWakeup({ customerId, reason: "从首页发起" }) : await draftInvite({ customerId });
      return res.ok ? { ok: true, value: res.message } : res;
    });
  const drafts = [
    { kind: "wakeup" as const, job: wakeup, title: "跟进话术草稿" },
    { kind: "invite" as const, job: invite, title: "转介绍邀请草稿" },
  ];
  return (
    <>
      <div className="home-actions">
        <button type="button" className="home-chip" onClick={() => run("wakeup")} disabled={wakeup?.status === "loading"}>
          <ThunderboltOutlined /> {wakeup?.status === "loading" ? "起草中…" : "起草跟进话术"}
        </button>
        {signed && (
          <button type="button" className="home-chip" onClick={() => run("invite")} disabled={invite?.status === "loading"}>
            <ThunderboltOutlined /> {invite?.status === "loading" ? "起草中…" : "起草转介绍邀请"}
          </button>
        )}
      </div>
      {drafts.map(({ kind, job, title }) => (
        <AnimatePresence key={kind}>
          {job?.status === "error" && <Alert key="e" type="warning" showIcon title={job.error} closable onClose={() => clearJob(`draft:${kind}:${customerId}`)} style={{ marginTop: 8 }} />}
          {job?.status === "done" && job.value && (
            <motion.div key="d" className="rec-ai-draft" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <div className="rec-ai-draft-t">{title}</div>
              <div>{job.value}</div>
              <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
                <Button
                  size="small"
                  type="link"
                  icon={<CopyOutlined />}
                  style={{ padding: 0 }}
                  onClick={async () => {
                    await navigator.clipboard.writeText(job.value!);
                    message.success(`已复制，去微信发给${b.customer}吧`);
                  }}
                >
                  复制
                </Button>
                <Button size="small" type="link" style={{ padding: 0 }} onClick={() => clearJob(`draft:${kind}:${customerId}`)}>
                  收起
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      ))}
    </>
  );
}
