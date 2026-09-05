"use client";

import { useMemo, useState } from "react";
import { Card, Input, Alert, Typography, Table, Space } from "antd";
import { ThunderboltOutlined } from "@ant-design/icons";
import type { EChartsCoreOption } from "echarts/core";
import Chart from "@/components/Chart";
import { askData, type AskResult } from "./ask";
import { useBusiness } from "@/lib/business-client";

/**
 * 问数据：一个输入框，一句结论，需要时一张图。
 * 不做对话历史——报表要的是当下这个数，翻旧账不如重问一遍。
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

  const chartOption: EChartsCoreOption | null = useMemo(() => {
    if (!result || result.rows.length < 2) return null;
    return {
      tooltip: {
        trigger: "axis",
        backgroundColor: "#fff",
        borderColor: "#e6edf6",
        textStyle: { color: "#334155", fontSize: 12 },
        valueFormatter: (v: number) => `${v}${result.unit === "%" ? "%" : ""}`,
      },
      grid: { left: 8, right: 12, top: 24, bottom: 4, containLabel: true },
      xAxis: {
        type: "category",
        data: result.rows.map((r) => r.label),
        axisLine: { lineStyle: { color: "#e8eef6" } },
        axisTick: { show: false },
        axisLabel: { color: "#94a3b8", fontSize: 12, interval: 0, rotate: result.rows.length > 6 ? 30 : 0 },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: "#f1f5f9" } },
        axisLabel: { color: "#94a3b8", fontSize: 12 },
      },
      series: [
        {
          name: result.metricLabel,
          type: "bar",
          data: result.rows.map((r) => r.value),
          itemStyle: { color: "#1668dc", borderRadius: [6, 6, 0, 0] },
          barMaxWidth: 46,
        },
      ],
    };
  }, [result]);

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

      {result && (
        <div style={{ marginTop: 16 }}>
          <Typography.Paragraph style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>
            {result.answer}
          </Typography.Paragraph>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {result.metricLabel}
            {result.groupByLabel ? ` · ${result.groupByLabel}` : ""} · {result.range} · 由 AI 解析生成，口径以数据复盘为准
          </Typography.Text>

          {chartOption && (
            <div style={{ marginTop: 12 }}>
              <Chart option={chartOption} height={240} />
            </div>
          )}
          {result.rows.length > 1 && (
            <Table
              size="small"
              style={{ marginTop: 12 }}
              rowKey={(r) => r.label}
              dataSource={result.rows}
              pagination={false}
              columns={[
                { title: result.groupByLabel ?? "分组", dataIndex: "label" },
                {
                  title: `${result.metricLabel}（${result.unit}）`,
                  dataIndex: "value",
                  width: 180,
                  render: (v: number, r) => (
                    <span style={{ fontWeight: 500 }}>
                      {v.toLocaleString("zh-CN")}
                      {r.note ? <span style={{ color: "#94a3b8", fontWeight: 400 }}>（{r.note}）</span> : null}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </div>
      )}
    </Card>
  );
}
