"use client";

import { useEffect, useState } from "react";
import { Button, Input, Alert, Typography, App, Tooltip } from "antd";
import { ThunderboltOutlined, ReloadOutlined, CopyOutlined, ArrowRightOutlined } from "@ant-design/icons";
import { motion, AnimatePresence } from "motion/react";
import { draftWakeup } from "../../dashboard/ai";
import { draftInvite } from "../../channels/ai";
import type { CustomerBrief, BriefRecord } from "@/lib/ai-draft";
import { useBusiness } from "@/lib/business-client";
import { runJob, useJob, setJobValue, clearJob, getJob } from "@/lib/ai-jobs";
import { runStream, type StreamJob } from "@/lib/ai-stream";
import AiTrace from "@/components/AiTrace";
import BriefBody from "./BriefBody";

type BriefAnswer = { brief: CustomerBrief; records: BriefRecord[] };

/**
 * 记录页右栏的 AI 面板：打开谁，它就已经读完了谁。
 *
 * 所有调用都挂在进程内任务表（ai-jobs）上，不挂在组件 state 上：
 * 切去别的页面再回来，转圈还在转、结果还在。简报走 /api/ai/stream，过程一步步可见；
 * 结果另外按「客户 + 时间线指纹」缓存进 sessionStorage，整页刷新也不重复调模型。
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

  const briefJob = useJob<StreamJob<BriefAnswer>>(briefKey);
  const askJob = useJob<StreamJob<BriefAnswer> & { question?: string }>(askKey);
  const wakeupJob = useJob<string>(`draft:wakeup:${customerId}`);
  const inviteJob = useJob<string>(`draft:invite:${customerId}`);
  const [q, setQ] = useState("");

  function regenerate() {
    clearJob(askKey);
    clearJob(briefKey);
    runStream<BriefAnswer>(briefKey, { mode: "brief", customerId });
  }
  function ask(question: string) {
    runStream<BriefAnswer>(askKey, { mode: "brief", customerId, question }, question);
  }

  // 简报生成完写进 sessionStorage；首次进入有缓存就直接用
  useEffect(() => {
    if (briefJob?.status === "done" && briefJob.value?.answer) {
      try {
        sessionStorage.setItem(briefKey, JSON.stringify(briefJob.value.answer));
      } catch {
        /* 存不了就不存 */
      }
    }
  }, [briefJob, briefKey]);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      if (cancelled || !hasRecords || getJob(briefKey)) return;
      try {
        const raw = sessionStorage.getItem(briefKey);
        if (raw) {
          setJobValue<StreamJob<BriefAnswer>>(briefKey, { steps: [], answer: JSON.parse(raw) as BriefAnswer });
          return;
        }
      } catch {
        /* 读不到就重新生成 */
      }
      runStream<BriefAnswer>(briefKey, { mode: "brief", customerId });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [briefKey, hasRecords, customerId]);

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
  const result = shown?.status === "done" ? shown.value?.answer : undefined;
  const steps = shown?.value?.steps ?? [];

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

      {hasRecords && (loading || steps.length > 0) && <AiTrace steps={steps} done={!loading} ms={shown?.value?.ms} compact />}

      <AnimatePresence mode="wait">
        {!loading && error && (
          <motion.div key="error" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <Alert type="warning" showIcon title={error} />
          </motion.div>
        )}
        {!loading && result && (
          <motion.div key={`brief-${shown?.meta ?? ""}-${result.brief.story.slice(0, 12)}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ marginTop: 8 }}>
            {shown?.meta && (
              <div className="rec-ai-q">
                问：{shown.meta}
                <a style={{ marginLeft: 8 }} onClick={() => clearJob(askKey)}>
                  回到简报
                </a>
              </div>
            )}
            <BriefBody brief={result.brief} records={result.records} />
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
        只起草，不落库。
      </Typography.Text>
    </div>
  );
}
