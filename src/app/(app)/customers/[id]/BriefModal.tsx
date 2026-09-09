"use client";

import { useEffect, useState } from "react";
import { Modal, Button, Spin, Alert, Space } from "antd";
import { ThunderboltOutlined, ReloadOutlined } from "@ant-design/icons";
import { generateBrief } from "./ai";
import type { CustomerBrief } from "@/lib/ai-draft";
import BriefBody from "./BriefBody";

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

      {brief && <BriefBody brief={brief} />}
    </Modal>
  );
}
