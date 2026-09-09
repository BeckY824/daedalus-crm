"use client";

import { useEffect, useState } from "react";
import { Button, Input, Alert, Typography, App, Tooltip } from "antd";
import { ThunderboltOutlined, ReloadOutlined, CopyOutlined, ArrowRightOutlined } from "@ant-design/icons";
import { motion, AnimatePresence } from "motion/react";
import type { generateBrief } from "./ai";
import { draftWakeup } from "../../dashboard/ai";
import { draftInvite } from "../../channels/ai";
import type { CustomerBrief } from "@/lib/ai-draft";
import { useBusiness } from "@/lib/business-client";

type State = { status: "idle" | "loading" | "done" | "error"; brief?: CustomerBrief; error?: string; question?: string };

/**
 * 记录页右栏的 AI 面板：打开谁，它就已经读完了谁。
 *
 * 进入页面自动生成一次简报，结果按「客户 + 时间线指纹」缓存在 sessionStorage：
 * 同一条记录反复打开不重复调模型，时间线一变（新增/删除跟进）指纹就变，下次打开重新生成。
 * 下面一个问题框：带着具体问题再问一次；再下面两个起草按钮。全部只起草，不落库。
 */
export default function AiPanel({
  customerId,
  customerName,
  fingerprint,
  signed,
  hasRecords,
}: {
  customerId: string;
  customerName: string;
  /** 时间线指纹：跟进条数 + 最新一条时间，用来判断缓存是否还新鲜 */
  fingerprint: string;
  signed: boolean;
  hasRecords: boolean;
}) {
  const b = useBusiness();
  const { message } = App.useApp();
  const cacheKey = `brief:${customerId}:${fingerprint}`;
  const [state, setState] = useState<State>({ status: "idle" });
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState<{ kind: "wakeup" | "invite"; text: string } | null>(null);
  const [drafting, setDrafting] = useState<"wakeup" | "invite" | null>(null);

  async function run(question?: string) {
    setState({ status: "loading", question });
    // 走 API 路由而不是 Server Action：后者会和页面上其它动作串行排队，简报一跑十几秒，
    // 用户这期间点保存会被卡住（见 api/ai/brief/route.ts）
    let res: Awaited<ReturnType<typeof generateBrief>>;
    try {
      const r = await fetch("/api/ai/brief", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customerId, question }) });
      res = (await r.json()) as Awaited<ReturnType<typeof generateBrief>>;
    } catch {
      res = { ok: false, error: "网络错误，请稍后重试" };
    }
    if (res.ok) {
      setState({ status: "done", brief: res.brief, question });
      if (!question) {
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify(res.brief));
        } catch {
          /* 存不了就不存 */
        }
      }
    } else setState({ status: "error", error: res.error, question });
  }

  // 首次进入：有缓存用缓存，没有就生成一次。没有任何跟进记录的不调模型，直说。
  // 严格模式下 effect 会挂载两次，靠 cleanup 里的 cancelled 保证只有最后一次生效。
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      if (cancelled) return;
      if (!hasRecords) {
        setState({ status: "error", error: `该${b.customer}还没有任何跟进记录，暂时没有可提炼的内容` });
        return;
      }
      let cached: CustomerBrief | null = null;
      try {
        const raw = sessionStorage.getItem(cacheKey);
        if (raw) cached = JSON.parse(raw) as CustomerBrief;
      } catch {
        cached = null;
      }
      if (cached) setState({ status: "done", brief: cached });
      else void run();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, hasRecords]);

  async function doDraft(kind: "wakeup" | "invite") {
    setDrafting(kind);
    const res =
      kind === "wakeup" ? await draftWakeup({ customerId, reason: "从记录页发起" }) : await draftInvite({ customerId });
    setDrafting(null);
    if (res.ok) setDraft({ kind, text: res.message });
    else message.error(res.error);
  }

  const brief = state.brief;

  return (
    <div className="rec-ai">
      <div className="rec-ai-head">
        <span className="rec-ai-title">
          <ThunderboltOutlined /> AI 已读完 {customerName} 的记录
        </span>
        <Tooltip title="重新生成简报">
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined spin={state.status === "loading"} />}
            onClick={() => void run()}
            disabled={state.status === "loading" || !hasRecords}
            aria-label="简报"
          >
            简报
          </Button>
        </Tooltip>
      </div>

      <AnimatePresence mode="wait">
        {state.status === "loading" && (
          <motion.div key="loading" className="rec-ai-loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <span className="rec-ai-dots">
              <i />
              <i />
              <i />
            </span>
            {state.question ? `正在围绕「${state.question.slice(0, 20)}」重读记录…` : "正在通读全部跟进记录…"}
          </motion.div>
        )}
        {state.status === "error" && (
          <motion.div key="error" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <Alert type="warning" showIcon title={state.error} />
          </motion.div>
        )}
        {state.status === "done" && brief && (
          <motion.div key={`brief-${state.question ?? ""}-${brief.story.slice(0, 12)}`} initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.12 } } }}>
            {state.question && (
              <motion.div variants={fade} className="rec-ai-q">
                问：{state.question}
              </motion.div>
            )}
            <Section label="故事线">{brief.story}</Section>
            {brief.current && <Section label="现在卡在哪">{brief.current}</Section>}
            {brief.talkingPoints.length > 0 && (
              <Section label={state.question ? "建议" : "这次建议谈"}>
                <ol className="rec-ai-list">
                  {brief.talkingPoints.map((p, i) => (
                    <motion.li key={i} variants={fade}>
                      {p}
                    </motion.li>
                  ))}
                </ol>
              </Section>
            )}
            {brief.risks.length > 0 && (
              <Section label="风险">
                {brief.risks.map((r, i) => (
                  <motion.div key={i} variants={fade} className="rec-ai-risk">
                    {r}
                  </motion.div>
                ))}
              </Section>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="rec-ai-ask">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`问一句，比如"下次该怎么谈报价"`}
          maxLength={200}
          disabled={!hasRecords}
          onPressEnter={() => {
            if (q.trim()) void run(q.trim());
          }}
          suffix={
            <Button type="text" size="small" icon={<ArrowRightOutlined />} disabled={!q.trim() || state.status === "loading"} onClick={() => void run(q.trim())} aria-label="问" />
          }
        />
      </div>

      <div className="rec-ai-actions">
        <Button size="small" loading={drafting === "wakeup"} onClick={() => void doDraft("wakeup")}>
          起草跟进话术
        </Button>
        {signed && (
          <Button size="small" loading={drafting === "invite"} onClick={() => void doDraft("invite")}>
            起草转介绍邀请
          </Button>
        )}
      </div>

      <AnimatePresence>
        {draft && (
          <motion.div key={draft.kind + draft.text.slice(0, 8)} className="rec-ai-draft" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="rec-ai-draft-t">{draft.kind === "wakeup" ? "跟进话术草稿" : "转介绍邀请草稿"}</div>
            <div>{draft.text}</div>
            <Button
              size="small"
              type="link"
              icon={<CopyOutlined />}
              style={{ padding: 0, marginTop: 6 }}
              onClick={async () => {
                await navigator.clipboard.writeText(draft.text);
                message.success(`已复制，去微信发给${b.customer}吧`);
              }}
            >
              复制
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      <Typography.Text type="secondary" className="rec-ai-foot">
        由 AI 基于系统内跟进记录生成，只起草，不落库。
      </Typography.Text>
    </div>
  );
}

const fade = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.28 } } };

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <motion.div variants={fade} className="rec-ai-sec">
      <div className="rec-ai-sec-k">{label}</div>
      <div className="rec-ai-sec-v">{children}</div>
    </motion.div>
  );
}
