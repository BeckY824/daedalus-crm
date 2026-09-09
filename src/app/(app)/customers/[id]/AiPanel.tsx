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
import { runJob, useJob, setJobValue, clearJob, getJob } from "@/lib/ai-jobs";

type BriefResult = { brief: CustomerBrief; question?: string };

/**
 * 记录页右栏的 AI 面板：打开谁，它就已经读完了谁。
 *
 * 所有调用都挂在进程内任务表（ai-jobs）上，不挂在组件 state 上：
 * 切去别的页面再回来，转圈还在转、结果还在。简报另外按「客户 + 时间线指纹」
 * 缓存进 sessionStorage，整页刷新也不重复调模型；时间线一变指纹就变。
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
  const briefKey = `brief:${customerId}:${fingerprint}`;
  const askKey = `brief-q:${customerId}`;

  const briefJob = useJob<BriefResult>(briefKey);
  const askJob = useJob<BriefResult>(askKey);
  const wakeupJob = useJob<string>(`draft:wakeup:${customerId}`);
  const inviteJob = useJob<string>(`draft:invite:${customerId}`);
  const [q, setQ] = useState("");

  async function callBrief(question?: string): Promise<{ ok: true; value: BriefResult } | { ok: false; error: string }> {
    // 走 API 路由而不是 Server Action：后者会和页面上其它动作串行排队，简报一跑十几秒，
    // 用户这期间点保存会被卡住（见 api/ai/brief/route.ts）
    let res: Awaited<ReturnType<typeof generateBrief>>;
    try {
      const r = await fetch("/api/ai/brief", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customerId, question }) });
      res = (await r.json()) as Awaited<ReturnType<typeof generateBrief>>;
    } catch {
      return { ok: false, error: "网络错误，请稍后重试" };
    }
    if (!res.ok) return res;
    if (!question) {
      try {
        sessionStorage.setItem(briefKey, JSON.stringify(res.brief));
      } catch {
        /* 存不了就不存 */
      }
    }
    return { ok: true, value: { brief: res.brief, question } };
  }

  function regenerate() {
    clearJob(askKey);
    clearJob(briefKey);
    runJob(briefKey, () => callBrief());
  }

  function ask(question: string) {
    runJob(askKey, () => callBrief(question), question);
  }

  // 首次进入：任务表里已有就什么都不做（可能正在转，也可能已完成）；
  // 否则试 sessionStorage，再没有就生成。没有跟进记录的不调模型。
  // 放在 setTimeout 里是为了不在 effect 体内同步写外部 store；严格模式双跑靠 cancelled 兜住。
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      if (cancelled || !hasRecords || getJob(briefKey)) return;
      try {
        const raw = sessionStorage.getItem(briefKey);
        if (raw) {
          setJobValue<BriefResult>(briefKey, { brief: JSON.parse(raw) as CustomerBrief });
          return;
        }
      } catch {
        /* 读不到就重新生成 */
      }
      runJob(briefKey, () => callBrief());
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefKey, hasRecords]);

  function doDraft(kind: "wakeup" | "invite") {
    runJob(`draft:${kind}:${customerId}`, async () => {
      const res = kind === "wakeup" ? await draftWakeup({ customerId, reason: "从记录页发起" }) : await draftInvite({ customerId });
      return res.ok ? { ok: true, value: res.message } : res;
    });
  }

  // 有追问就显示追问的结果，否则显示简报本身
  const shown = askJob ?? briefJob;
  const loading = shown?.status === "loading";
  const error = !hasRecords ? `该${b.customer}还没有任何跟进记录，暂时没有可提炼的内容` : shown?.status === "error" ? shown.error : null;
  const result = shown?.status === "done" ? shown.value : undefined;

  return (
    <div className="rec-ai">
      <div className="rec-ai-head">
        <span className="rec-ai-title">
          <ThunderboltOutlined /> AI 已读完 {customerName} 的记录
        </span>
        <Tooltip title="重新生成简报">
          <Button size="small" type="text" icon={<ReloadOutlined spin={loading} />} onClick={regenerate} disabled={loading || !hasRecords} aria-label="简报">
            简报
          </Button>
        </Tooltip>
      </div>

      <AnimatePresence mode="wait">
        {loading && (
          <motion.div key="loading" className="rec-ai-loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <span className="rec-ai-dots">
              <i />
              <i />
              <i />
            </span>
            {shown?.meta ? `正在围绕「${shown.meta.slice(0, 20)}」重读记录…` : "正在通读全部跟进记录…"}
          </motion.div>
        )}
        {!loading && error && (
          <motion.div key="error" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <Alert type="warning" showIcon title={error} />
          </motion.div>
        )}
        {!loading && result && (
          <motion.div key={`brief-${result.question ?? ""}-${result.brief.story.slice(0, 12)}`} initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.12 } } }}>
            {result.question && (
              <motion.div variants={fade} className="rec-ai-q">
                问：{result.question}
                <a style={{ marginLeft: 8 }} onClick={() => clearJob(askKey)}>
                  回到简报
                </a>
              </motion.div>
            )}
            <Section label="故事线">{result.brief.story}</Section>
            {result.brief.current && <Section label="现在卡在哪">{result.brief.current}</Section>}
            {result.brief.talkingPoints.length > 0 && (
              <Section label={result.question ? "建议" : "这次建议谈"}>
                <ol className="rec-ai-list">
                  {result.brief.talkingPoints.map((p, i) => (
                    <motion.li key={i} variants={fade}>
                      {p}
                    </motion.li>
                  ))}
                </ol>
              </Section>
            )}
            {result.brief.risks.length > 0 && (
              <Section label="风险">
                {result.brief.risks.map((r, i) => (
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
            if (q.trim()) {
              ask(q.trim());
              setQ("");
            }
          }}
          suffix={
            <Button
              type="text"
              size="small"
              icon={<ArrowRightOutlined />}
              disabled={!q.trim() || loading}
              onClick={() => {
                ask(q.trim());
                setQ("");
              }}
              aria-label="问"
            />
          }
        />
      </div>

      <div className="rec-ai-actions">
        <Button size="small" loading={wakeupJob?.status === "loading"} onClick={() => doDraft("wakeup")}>
          起草跟进话术
        </Button>
        {signed && (
          <Button size="small" loading={inviteJob?.status === "loading"} onClick={() => doDraft("invite")}>
            起草转介绍邀请
          </Button>
        )}
      </div>

      {[
        { kind: "wakeup" as const, job: wakeupJob, title: "跟进话术草稿" },
        { kind: "invite" as const, job: inviteJob, title: "转介绍邀请草稿" },
      ].map(({ kind, job, title }) => (
        <AnimatePresence key={kind}>
          {job?.status === "error" && (
            <motion.div key="err" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ marginTop: 8 }}>
              <Alert type="warning" showIcon title={job.error} closable onClose={() => clearJob(`draft:${kind}:${customerId}`)} />
            </motion.div>
          )}
          {job?.status === "done" && job.value && (
            <motion.div key={job.value.slice(0, 8)} className="rec-ai-draft" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
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
