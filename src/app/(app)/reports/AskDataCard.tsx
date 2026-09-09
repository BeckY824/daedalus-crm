"use client";

import { useState } from "react";
import { Card, Input, Alert, Space } from "antd";
import { ThunderboltOutlined } from "@ant-design/icons";
import { askData, type AskResult } from "./ask";
import AskDataResult from "./AskDataResult";
import { useBusiness } from "@/lib/business-client";

/**
 * 问数据：一个输入框，一句结论，需要时一张图。
 * 不做对话历史——报表要的是当下这个数，翻旧账不如重问一遍。
 * 结果的呈现抽在 AskDataResult 里，首页提问复用同一份。
 */
export default function AskDataCard() {
  const b = useBusiness();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskResult | null>(null);

  async function ask(q: string) {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    const res = await askData(q);
    setLoading(false);
    if (res.ok) setResult(res.result);
    else {
      setResult(null);
      setError(res.error);
    }
  }

  return (
    <Card
      style={{ marginBottom: 16 }}
      title={
        <Space size={8}>
          <ThunderboltOutlined style={{ color: "#1668dc" }} />
          <span className="section-title">问数据</span>
        </Space>
      }
    >
      <Input.Search
        placeholder={`用一句话问业务数字，如：这个月哪个销售新增${b.customer}最多？各渠道签约金额是多少？`}
        enterButton="问"
        loading={loading}
        onSearch={ask}
        maxLength={300}
      />

      {error && <Alert type="warning" showIcon title={error} style={{ marginTop: 14 }} />}
      {result && <AskDataResult result={result} />}
    </Card>
  );
}
