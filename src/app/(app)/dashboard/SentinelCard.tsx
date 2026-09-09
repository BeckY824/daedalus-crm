"use client";

import Link from "next/link";
import { Card, Tag, Button, Space, Typography, App } from "antd";
import { EyeOutlined, ThunderboltOutlined, CopyOutlined, BulbOutlined } from "@ant-design/icons";
import type { WatchItem } from "@/lib/sentinel";
import { KIND_LABEL } from "@/lib/sentinel";
import { draftWakeup, explainWatchlist } from "./ai";
import { useBusiness } from "@/lib/business-client";
import { runJob, useJob, clearJob } from "@/lib/ai-jobs";

const KIND_COLOR: Record<WatchItem["kind"], string> = {
  overdue_plan: "error",
  sleeping: "warning",
  stalled_opp: "processing",
};

/**
 * 盯盘提醒：正在被遗忘的学员/商机/计划，按优先级排列。
 * 「起草跟进」生成微信话术草稿，由销售自己复制发出——AI 起草、人签发。
 */
export default function SentinelCard({ items, aiEnabled }: { items: WatchItem[]; aiEnabled: boolean }) {
  const { message } = App.useApp();
  const b = useBusiness();
  const kindLabel = (k: WatchItem["kind"]) => KIND_LABEL[k].replace("学员", b.customer);
  // 解读与话术都挂在进程内任务表上（ai-jobs），离开首页再回来，转圈和结果都还在。
  // 话术的 key 与记录页共用：两边起草的是同一条，互相能看到
  const explainJob = useJob<Record<string, string>>("sentinel:explain");
  const notes = explainJob?.status === "done" ? explainJob.value : null;
  const explaining = explainJob?.status === "loading";

  /** 一次调用给整张清单各补一句"从哪接上"。按需触发，不随页面加载自动跑 */
  function explain() {
    runJob("sentinel:explain", async () => {
      const res = await explainWatchlist({ items: items.map((it) => ({ customerId: it.customerId, reason: it.reason })) });
      if (!res.ok) message.error(res.error);
      return res.ok ? { ok: true, value: res.notes } : res;
    });
  }

  function draft(it: WatchItem) {
    runJob(`draft:wakeup:${it.customerId}`, async () => {
      const res = await draftWakeup({ customerId: it.customerId, reason: it.reason });
      if (!res.ok) message.error(res.error);
      return res.ok ? { ok: true, value: res.message } : res;
    });
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    message.success(`已复制，去微信发给${b.customer}吧`);
  }

  return (
    <Card
      style={{ marginTop: 16 }}
      title={
        <Space size={8}>
          <EyeOutlined style={{ color: "#1668dc" }} />
          <span className="section-title">盯盘提醒</span>
          <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>
            {items.length} 项正在被遗忘
          </Typography.Text>
        </Space>
      }
      extra={
        aiEnabled && !notes ? (
          <Button size="small" icon={<BulbOutlined />} loading={explaining} onClick={explain}>
            AI 解读
          </Button>
        ) : null
      }
      styles={{ body: { paddingTop: 6 } }}
    >
      {items.map((it) => (
        <SentinelRow key={it.customerId} it={it} aiEnabled={aiEnabled} note={notes?.[it.customerId]} kindLabel={kindLabel} onDraft={() => draft(it)} onCopy={copy} />
      ))}
    </Card>
  );
}

/** 单行拆成组件，是为了每行各自订阅自己的话术任务 */
function SentinelRow({
  it,
  aiEnabled,
  note,
  kindLabel,
  onDraft,
  onCopy,
}: {
  it: WatchItem;
  aiEnabled: boolean;
  note?: string;
  kindLabel: (k: WatchItem["kind"]) => string;
  onDraft: () => void;
  onCopy: (t: string) => void;
}) {
  const job = useJob<string>(`draft:wakeup:${it.customerId}`);
  const draftText = job?.status === "done" ? job.value : undefined;
  return (
        <div style={{ padding: "12px 0", borderBottom: "1px dashed #eef2f7" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Tag color={KIND_COLOR[it.kind]} style={{ margin: 0, borderRadius: 6, flex: "none" }}>
              {kindLabel(it.kind)}
            </Tag>
            <Link href={`/customers/${it.customerId}`} className="link-strong" style={{ fontSize: 15, fontWeight: 500 }}>
              {it.customerName}
            </Link>
            <span style={{ flex: 1, minWidth: 200, color: "#64748b", fontSize: 14 }}>{it.reason}</span>
            <span style={{ color: "#94a3b8", fontSize: 13, flex: "none" }}>{it.ownerName}</span>
            {aiEnabled && !draftText && (
              <Button size="small" icon={<ThunderboltOutlined />} loading={job?.status === "loading"} onClick={onDraft}>
                起草跟进
              </Button>
            )}
          </div>
          {note && (
            <div style={{ marginTop: 6, paddingLeft: 2, fontSize: 14, color: "#334155" }}>
              <BulbOutlined style={{ color: "#f59e0b", marginRight: 6 }} />
              {note}
            </div>
          )}
          {draftText && (
            <div
              style={{
                marginTop: 10,
                background: "#f6f9fe",
                border: "1px solid #dbe8fa",
                borderRadius: 8,
                padding: "10px 14px",
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
              }}
            >
              <div style={{ flex: 1, fontSize: 14, lineHeight: 1.8 }}>{draftText}</div>
              <Button size="small" type="primary" ghost icon={<CopyOutlined />} onClick={() => onCopy(draftText)}>
                复制
              </Button>
              <Button size="small" type="text" onClick={() => clearJob(`draft:wakeup:${it.customerId}`)}>
                收起
              </Button>
            </div>
          )}
        </div>
  );
}
