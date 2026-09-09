"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Button, Input, Alert, App } from "antd";
import { ArrowUpOutlined, ArrowRightOutlined, ReloadOutlined, DeleteOutlined, BarChartOutlined } from "@ant-design/icons";
import { motion, AnimatePresence } from "motion/react";
import { askHome, quickBrief, type HomeAnswer } from "./ask";
import AskDataResult from "../reports/AskDataResult";
import BriefBody from "../customers/[id]/BriefBody";
import { useBusiness } from "@/lib/business-client";
import { runJob, useJob, clearJob } from "@/lib/ai-jobs";
import { addTurn, clearThread, removeTurn, useThread, type Turn } from "@/lib/home-thread";

export type Suggestion = { label: string; question: string; kind?: "ask" | "prep" | "recap" };

/**
 * 首页 = 一个对话面。
 * 没有指标卡、没有图表——那些在「数据看板」。这里只有：问候、一个输入框、几枚按当前处境
 * 生成的建议 chip，以及一条随问随答的线程。每一问各自独立（不带上下文记忆），
 * 问到某位客户出简报，问到数字出图表，和记录页、报表页是同一套能力。
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

  function submit(question: string, kind: Turn["kind"] = "ask") {
    const text = question.trim();
    if (kind === "ask" && text.length < 2) return;
    const turn = addTurn({ question: kind === "ask" ? text : question, kind });
    runJob(`home:${turn.id}`, async () => {
      const res = kind === "ask" ? await askHome(text) : await quickBrief(kind);
      return res.ok ? { ok: true, value: res.answer } : res;
    });
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
              <TurnView key={t.id} turn={t} onRetry={() => { clearJob(`home:${t.id}`); runJob(`home:${t.id}`, async () => { const res = t.kind === "ask" ? await askHome(t.question) : await quickBrief(t.kind); return res.ok ? { ok: true, value: res.answer } : res; }); }} onRemove={() => { clearJob(`home:${t.id}`); removeTurn(t.id); }} />
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
              <button type="button" className="home-chip home-chip-ghost" onClick={() => { turns.forEach((t) => clearJob(`home:${t.id}`)); clearThread(); }}>
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
  const job = useJob<HomeAnswer>(`home:${turn.id}`);
  const ref = useRef<HTMLDivElement>(null);
  // 回答落地时把这一轮滚进视野：答案是异步来的，只在提问时滚一次不够
  const done = job?.status === "done" || job?.status === "error";
  useEffect(() => {
    if (done) ref.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [done]);
  const label = turn.kind === "prep" ? "准备下次跟进" : turn.kind === "recap" ? "回顾上次沟通" : turn.question;
  return (
    <motion.div ref={ref} className="home-turn" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
      <div className="home-q">
        <span>{label}</span>
        <button type="button" className="home-turn-x" onClick={onRemove} aria-label="移除这一问">
          ×
        </button>
      </div>
      <div className="home-a">
        {(!job || job.status === "loading") && (
          <div className="rec-ai-loading" style={{ padding: "6px 0" }}>
            <span className="rec-ai-dots">
              <i />
              <i />
              <i />
            </span>
            {turn.kind === "ask" ? "正在读记录…" : "正在挑最该联系的那位…"}
          </div>
        )}
        {job?.status === "error" && (
          <Alert
            type="warning"
            showIcon
            title={job.error}
            action={
              <Button size="small" type="text" icon={<ReloadOutlined />} onClick={onRetry}>
                重试
              </Button>
            }
          />
        )}
        {job?.status === "done" && job.value && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
            {job.value.kind === "customer" ? (
              <>
                <div className="home-a-head">
                  <span className="home-a-name">{job.value.customerName}</span>
                  <Link href={`/customers/${job.value.customerId}`} className="home-a-link">
                    打开{b.customer}页 <ArrowRightOutlined />
                  </Link>
                </div>
                <BriefBody brief={job.value.brief} />
              </>
            ) : (
              <>
                <div className="home-a-head">
                  <span className="home-a-name">问数据</span>
                  <a className="home-a-link" onClick={() => { void navigator.clipboard.writeText(job.value!.kind === "data" ? job.value!.result.answer : ""); message.success("已复制结论"); }}>
                    复制结论
                  </a>
                </div>
                <AskDataResult result={job.value.result} />
              </>
            )}
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}
