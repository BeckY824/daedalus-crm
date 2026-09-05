"use client";

import { useEffect, useState } from "react";
import { Modal, Button, Spin, Typography, Alert, Space, Tag } from "antd";
import { ThunderboltOutlined, ReloadOutlined } from "@ant-design/icons";
import { generateBrief } from "./ai";
import type { CustomerBrief } from "@/lib/ai-draft";

/** 无结果即加载中——不单设 loading 标志，避免在 effect 里同步 setState */
type Result = { brief: CustomerBrief } | { error: string };

/**
 * 临战简报：联系学员前一键生成的一页纸。
 * 内容每次现算不落库——简报的价值就在"基于此刻的时间线"，存下来只会过期。
 * 弹窗反复开关时复用上次结果，想要最新就点「重新生成」。
 */
export default function BriefModal({
  open,
  onClose,
  customerId,
  customerName,
}: {
  open: boolean;
  onClose: () => void;
  customerId: string;
  customerName: string;
}) {
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!open || result) return;
    let cancelled = false;
    void generateBrief({ customerId }).then((res) => {
      if (cancelled) return;
      setResult(res.ok ? { brief: res.brief } : { error: res.error });
    });
    return () => {
      cancelled = true;
    };
  }, [open, result, customerId]);

  const loading = open && !result;
  const brief = result && "brief" in result ? result.brief : null;
  const error = result && "error" in result ? result.error : null;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={
        <Space size={8}>
          <ThunderboltOutlined style={{ color: "#1668dc" }} />
          <span>临战简报 · {customerName}</span>
        </Space>
      }
      width={620}
      footer={[
        <Button key="regen" icon={<ReloadOutlined />} onClick={() => setResult(null)} disabled={loading}>
          重新生成
        </Button>,
        <Button key="close" type="primary" onClick={onClose}>
          关闭
        </Button>,
      ]}
    >
      {loading && (
        <div style={{ textAlign: "center", padding: "48px 0" }}>
          <Spin />
          <div style={{ marginTop: 14, color: "#5a6a80" }}>正在通读跟进时间线，整理简报…</div>
        </div>
      )}

      {error && <Alert type="warning" showIcon title={error} style={{ margin: "12px 0" }} />}

      {brief && (
        <div style={{ paddingTop: 4 }}>
          <Section title="故事线">
            <Typography.Paragraph style={{ marginBottom: 0 }}>{brief.story}</Typography.Paragraph>
          </Section>
          {brief.current && (
            <Section title="当前局面">
              <Typography.Paragraph style={{ marginBottom: 0 }}>{brief.current}</Typography.Paragraph>
            </Section>
          )}
          {brief.talkingPoints.length > 0 && (
            <Section title="这次建议谈">
              <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 2 }}>
                {brief.talkingPoints.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ol>
            </Section>
          )}
          {brief.risks.length > 0 && (
            <Section title="风险提示">
              <Space orientation="vertical" size={6} style={{ width: "100%" }}>
                {brief.risks.map((r, i) => (
                  <Tag key={i} color="warning" style={{ whiteSpace: "normal", padding: "4px 10px", margin: 0 }}>
                    {r}
                  </Tag>
                ))}
              </Space>
            </Section>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            由 AI 基于系统内跟进记录生成，仅供参考，请以实际沟通为准。
          </Typography.Text>
        </div>
      )}
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="stat-label" style={{ marginBottom: 6 }}>
        {title}
      </div>
      {children}
    </div>
  );
}
