"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, Typography, Space, Empty, App, Button, Tag } from "antd";
import { PartitionOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { PageHead } from "@/components/ui";
import { OPP_STAGES, OPP_STAGE_COLOR } from "@/lib/constants";
import { money, fmtDate } from "@/lib/utils";
import { moveStage } from "../actions";

type Row = {
  id: string;
  name: string;
  amount: number;
  stage: string;
  probability: number;
  expectedDealAt: string | null;
  customerId: string;
  customerName: string;
  ownerName: string;
};

export default function PipelineView({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);

  async function drop(stage: string) {
    setOverStage(null);
    if (!dragId) return;
    const row = rows.find((r) => r.id === dragId);
    setDragId(null);
    if (!row || row.stage === stage) return;
    const res = await moveStage(dragId, stage);
    if (!res.ok) {
      message.error(res.error);
      router.refresh();
      return;
    }
    message.success(`「${row.name}」已推进到 ${stage}`);
    router.refresh();
  }

  return (
    <>
      <PageHead
        icon={<PartitionOutlined />}
        title="商机管道"
        subtitle="拖拽卡片即可推进阶段"
        tag="商机管理"
        tagNote="可视化管道，管理销售节奏"
        extra={
          <Button icon={<UnorderedListOutlined />} onClick={() => router.push("/opportunities")}>
            列表视图
          </Button>
        }
      />

      <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 8, alignItems: "flex-start" }}>
        {OPP_STAGES.map((stage) => {
          const items = rows.filter((r) => r.stage === stage);
          const sum = items.reduce((s, r) => s + r.amount, 0);
          const color = OPP_STAGE_COLOR[stage];
          const active = overStage === stage;

          return (
            <div
              key={stage}
              onDragOver={(e) => {
                e.preventDefault();
                setOverStage(stage);
              }}
              onDragLeave={() => setOverStage((s) => (s === stage ? null : s))}
              onDrop={() => drop(stage)}
              style={{
                flex: "0 0 272px",
                background: active ? "#e8f1fe" : "#fff",
                border: `1px solid ${active ? "#9dc4f8" : "#eef2f7"}`,
                borderRadius: 12,
                padding: 12,
                minHeight: 220,
                transition: "background .15s, border-color .15s",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
                <span style={{ fontWeight: 600, fontSize: 14 }}>{stage}</span>
                <Tag style={{ margin: 0, borderRadius: 10, fontSize: 11 }}>{items.length}</Tag>
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {money(sum)}
              </Typography.Text>
              <div style={{ height: 3, background: color, borderRadius: 2, opacity: 0.5, margin: "10px 0 12px" }} />

              {items.length === 0 && (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无商机" style={{ margin: "24px 0" }} />
              )}

              <Space orientation="vertical" size={10} style={{ width: "100%" }}>
                {items.map((r) => (
                  <Card
                    key={r.id}
                    size="small"
                    draggable
                    onDragStart={() => setDragId(r.id)}
                    onDragEnd={() => setDragId(null)}
                    styles={{ body: { padding: 12 } }}
                    style={{
                      cursor: "grab",
                      opacity: dragId === r.id ? 0.45 : 1,
                      borderLeft: `3px solid ${color}`,
                    }}
                  >
                    <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>{r.name}</div>
                    <Link href={`/customers/${r.customerId}`} style={{ fontSize: 12, color: "#64748b" }}>
                      {r.customerName}
                    </Link>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 14, color: "#10233d" }}>{money(r.amount)}</span>
                      <span style={{ fontSize: 12, color: "#94a3b8" }}>{r.probability}%</span>
                    </div>
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6, display: "flex", justifyContent: "space-between" }}>
                      <span>{r.ownerName}</span>
                      <span>{fmtDate(r.expectedDealAt)}</span>
                    </div>
                  </Card>
                ))}
              </Space>
            </div>
          );
        })}
      </div>
    </>
  );
}
