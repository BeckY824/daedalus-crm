"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Tag, Button, Space, Typography, App } from "antd";
import { EyeOutlined, ThunderboltOutlined, CopyOutlined } from "@ant-design/icons";
import type { WatchItem } from "@/lib/sentinel";
import { KIND_LABEL } from "@/lib/sentinel";
import { draftWakeup } from "./ai";

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
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  async function draft(it: WatchItem) {
    setLoadingId(it.customerId);
    const res = await draftWakeup({ customerId: it.customerId, reason: it.reason });
    setLoadingId(null);
    if (res.ok) setDrafts((d) => ({ ...d, [it.customerId]: res.message }));
    else message.error(res.error);
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    message.success("已复制，去微信发给学员吧");
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
      styles={{ body: { paddingTop: 6 } }}
    >
      {items.map((it) => (
        <div key={it.customerId} style={{ padding: "12px 0", borderBottom: "1px dashed #eef2f7" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Tag color={KIND_COLOR[it.kind]} style={{ margin: 0, borderRadius: 6, flex: "none" }}>
              {KIND_LABEL[it.kind]}
            </Tag>
            <Link href={`/customers/${it.customerId}`} className="link-strong" style={{ fontSize: 15, fontWeight: 500 }}>
              {it.customerName}
            </Link>
            <span style={{ flex: 1, minWidth: 200, color: "#64748b", fontSize: 14 }}>{it.reason}</span>
            <span style={{ color: "#94a3b8", fontSize: 13, flex: "none" }}>{it.ownerName}</span>
            {aiEnabled && !drafts[it.customerId] && (
              <Button
                size="small"
                icon={<ThunderboltOutlined />}
                loading={loadingId === it.customerId}
                onClick={() => draft(it)}
              >
                起草跟进
              </Button>
            )}
          </div>
          {drafts[it.customerId] && (
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
              <div style={{ flex: 1, fontSize: 14, lineHeight: 1.8 }}>{drafts[it.customerId]}</div>
              <Button size="small" type="primary" ghost icon={<CopyOutlined />} onClick={() => copy(drafts[it.customerId])}>
                复制
              </Button>
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}
