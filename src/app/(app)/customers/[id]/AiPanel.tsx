"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Input, Alert, Typography, Tooltip, Dropdown } from "antd";
import { ThunderboltOutlined, ReloadOutlined, CopyOutlined, ArrowUpOutlined, DownOutlined, EditOutlined } from "@ant-design/icons";
import { motion, AnimatePresence } from "motion/react";
import type { CustomerBrief, BriefRecord } from "@/lib/ai-draft";
import { useBusiness } from "@/lib/business-client";
import { useJob, setJobValue, clearJob, getJob } from "@/lib/ai-jobs";
import { runStream, type StreamJob } from "@/lib/ai-stream";
import AiTrace from "@/components/AiTrace";
import AiWait from "@/components/AiWait";
import BriefBody from "./BriefBody";
import AiCost, { useAiMeter } from "@/components/AiCost";
import { 起草, 草稿键, useCopyDraft, type 草稿类 } from "@/lib/draft-jobs";
import { 起草语言们, 起草语气们, type 起草语言, type 起草语气 } from "@/lib/draft-style";
import { useLocalPref } from "@/lib/local-pref";

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
  // 自己 Key、付费、自部署的人不花次数，那句「会用掉 1 次」对他们不成立（lib/ai-meter.ts）
  const { 计次 } = useAiMeter();
  const briefKey = `brief:${customerId}:${fingerprint}`;
  const askKey = `brief-q:${customerId}`;

  const briefJob = useJob<StreamJob<BriefAnswer>>(briefKey);
  const askJob = useJob<StreamJob<BriefAnswer> & { question?: string }>(askKey);
  const wakeupJob = useJob<string>(草稿键("wakeup", customerId));
  const inviteJob = useJob<string>(草稿键("invite", customerId));
  const [q, setQ] = useState("");

  /** 侧栏那条「AI 任务」认这个：叫什么、点了回哪儿 */
  const 标签 = useMemo(() => ({ 名: `${customerName} 的简报`, 去: `/customers/${customerId}` }), [customerName, customerId]);

  function regenerate() {
    clearJob(askKey);
    clearJob(briefKey);
    runStream<BriefAnswer>(briefKey, { mode: "brief", customerId }, undefined, 标签);
  }
  function ask(question: string) {
    runStream<BriefAnswer>(askKey, { mode: "brief", customerId, question }, question, { 名: `问 ${customerName}：${question.slice(0, 12)}`, 去: `/customers/${customerId}` });
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

  /**
   * 进这一页**不自动生成简报**（2026-09-18 改）。
   *
   * 原来是打开一位学员就先去问一次 AI。看着贴心，实际是：随手点开三个人看看电话，
   * 三次调用就没了——而免费额度一个月只有 30 次。翻记录和问 AI 是两件事，
   * 前者是每天几十次的动作，后者是"我要准备这一通电话了"。
   *
   * 这里只做一件免费的事：把这一版记录**之前已经生成过**的简报从缓存里捞回来
   * （key 里带 fingerprint，记录变了就自然落空）。要新的，点按钮。
   */
  useEffect(() => {
    if (!hasRecords || getJob(briefKey)) return;
    try {
      const raw = sessionStorage.getItem(briefKey);
      if (raw) setJobValue<StreamJob<BriefAnswer>>(briefKey, { steps: [], answer: JSON.parse(raw) as BriefAnswer });
    } catch {
      /* 读不到就等人点「生成简报」 */
    }
  }, [briefKey, hasRecords]);

  /*
    起草的语言和语气（输入框底下那两枚芯片，2026-10-02 照毛玻璃原型）：外贸客户多半不说中文，
    原来起草出来一律是中文微信。选过的记在这台电脑上，下一位客户接着用
  */
  const [语言, set语言] = useLocalPref<起草语言>("draft.lang", "自动");
  const [语气, set语气] = useLocalPref<起草语气>("draft.tone", "随和");
  const doDraft = (kind: 草稿类) => 起草(kind, customerId, "从记录页发起", { 语言, 语气 });
  const 复制 = useCopyDraft();

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
          {/* 没生成过就别说「已读完」——那是句还没发生的话 */}
          <ThunderboltOutlined /> {result ? `AI 已读完 ${customerName} 的记录` : `AI 可以读 ${customerName} 的记录`}
        </span>
        {(result || loading) && (
          <Tooltip title="重新生成简报">
            <Button size="small" type="text" icon={<ReloadOutlined spin={loading} />} onClick={regenerate} disabled={loading || !hasRecords} aria-label="简报">
              简报
              <AiCost />
            </Button>
          </Tooltip>
        )}
      </div>

      {hasRecords && (loading || steps.length > 0) && <AiTrace steps={steps} done={!loading} ms={shown?.value?.ms} compact />}

      {/* 还没生成过：摆一颗按钮，不替人做决定。点了才花那一次额度 */}
      {hasRecords && !loading && !result && !error && (
        <div className="rec-ai-idle">
          <Button type="primary" size="small" icon={<ThunderboltOutlined />} onClick={regenerate}>
            生成简报
          </Button>
          <span>读完这位{b.customer}的全部跟进，给一段故事线和下一步建议。{计次 && "会用掉 1 次 AI 额度。"}</span>
        </div>
      )}

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

      {/*
        一个框：上面问一句，下面一排芯片——起草什么、用什么语言、什么语气，最右边是发送。
        芯片是「起草」的参数，不影响「问一句」（问答按你提问的语言答）。
      */}
      <div className={`rec-composer${!hasRecords ? " off" : ""}`}>
        <Input
          variant="borderless"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`问一句，比如"下次该怎么谈报价"`}
          maxLength={200}
          disabled={!hasRecords}
          aria-label={`问 AI 关于 ${customerName} 的事`}
          onPressEnter={() => {
            if (q.trim()) {
              ask(q.trim());
              setQ("");
            }
          }}
          suffix={
          <Button
              type="primary"
              size="small"
              className="rec-send"
              icon={<ArrowUpOutlined />}
              disabled={!q.trim() || loading}
              onClick={() => {
                ask(q.trim());
                setQ("");
              }}
              aria-label="问"
            />
          }
        />
        <div className="rec-chips">
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                { key: "wakeup", label: <>起草跟进话术 <AiCost /></>, disabled: wakeupJob?.status === "loading" },
                ...(signed ? [{ key: "invite", label: <>起草转介绍邀请 <AiCost /></>, disabled: inviteJob?.status === "loading" }] : []),
              ],
              onClick: ({ key }) => doDraft(key as 草稿类),
            }}
          >
            <button type="button" className="rec-chip rec-chip-main">
              <EditOutlined /> 起草
              <DownOutlined className="rec-chip-caret" />
            </button>
          </Dropdown>
          <Dropdown
            trigger={["click"]}
            menu={{ items: 起草语言们.map((x) => ({ key: x, label: x === "自动" ? "自动（跟着记录里对方的语言）" : x })), selectable: true, selectedKeys: [语言], onClick: ({ key }) => set语言(key as 起草语言) }}
          >
            <button type="button" className="rec-chip" aria-label={`起草用的语言：${语言}`}>
              {语言 === "自动" ? "语言：自动" : 语言}
              <DownOutlined className="rec-chip-caret" />
            </button>
          </Dropdown>
          <Dropdown
            trigger={["click"]}
            menu={{ items: 起草语气们.map((x) => ({ key: x, label: x })), selectable: true, selectedKeys: [语气], onClick: ({ key }) => set语气(key as 起草语气) }}
          >
            <button type="button" className="rec-chip" aria-label={`起草用的语气：${语气}`}>
              语气：{语气}
              <DownOutlined className="rec-chip-caret" />
            </button>
          </Dropdown>
        </div>
      </div>

      {[
        { kind: "wakeup" as const, job: wakeupJob, title: "跟进话术草稿", 在做: `读 ${customerName} 的跟进，起草一段能直接发的微信` },
        { kind: "invite" as const, job: inviteJob, title: "转介绍邀请草稿", 在做: `照 ${customerName} 的情况，起草一段请他介绍朋友的微信` },
      ].map(({ kind, job, title, 在做 }) => (
        <AnimatePresence key={kind}>
          {job?.status === "loading" && (
            <div key="run" style={{ marginTop: 8 }}>
              <AiWait 在做={在做} 起={job.startedAt} />
            </div>
          )}
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
                  onClick={() => 复制(job.value!)}
                >
                  复制
                </Button>
                <Button size="small" type="link" style={{ padding: 0 }} onClick={() => clearJob(草稿键(kind, customerId))}>
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
