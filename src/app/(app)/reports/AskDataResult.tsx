"use client";

import { useMemo } from "react";
import { Typography, Table } from "antd";
import type { EChartsCoreOption } from "echarts/core";
import Chart from "@/components/Chart";
import type { AskResult } from "./ask";

/** 问数据的结果：一句结论 + 口径说明，多于一行时附柱图与表 */
export default function AskDataResult({ result }: { result: AskResult }) {
  const chartOption: EChartsCoreOption | null = useMemo(() => {
    if (result.rows.length < 2) return null;
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
  );
}
