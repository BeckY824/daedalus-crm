"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { Card, Row, Col, Segmented, Select, Table, Empty, Space, Typography } from "antd";
import { BarChartOutlined, PayCircleOutlined, FileDoneOutlined, RiseOutlined } from "@ant-design/icons";
import type { EChartsCoreOption } from "echarts/core";
import Chart from "@/components/Chart";
import AskDataCard from "./AskDataCard";
import { PageHead, StatCard } from "@/components/ui";
import { money } from "@/lib/utils";

type Bucket = { label: string; amount: number; count: number };
type Agg = { id: string; name: string; amount: number; count: number };

export default function ReportsView({
  period, year, yearOptions, trend, bySales, byChannelOwner, byChannel, byAttribution, total, aiEnabled,
}: {
  period: string;
  year: number;
  yearOptions: number[];
  trend: Bucket[];
  bySales: Agg[];
  byChannelOwner: Agg[];
  byChannel: Agg[];
  byAttribution: Agg[];
  total: { amount: number; count: number };
  /** 服务端是否配置了 AI。没配时「问数据」整卡不渲染 */
  aiEnabled: boolean;
}) {
  const router = useRouter();

  function go(next: { period?: string; year?: number }) {
    const q = new URLSearchParams();
    q.set("period", next.period ?? period);
    q.set("year", String(next.year ?? year));
    router.push(`/reports?${q}`);
  }

  const trendOption: EChartsCoreOption = useMemo(
    () => ({
      tooltip: {
        trigger: "axis",
        backgroundColor: "#fff",
        borderColor: "#e6edf6",
        textStyle: { color: "#334155", fontSize: 12 },
        extraCssText: "box-shadow:0 6px 20px rgba(16,43,77,.12);border-radius:8px;",
        valueFormatter: (v: number) => "¥ " + v.toLocaleString(),
      },
      grid: { left: 8, right: 12, top: 30, bottom: 4, containLabel: true },
      xAxis: {
        type: "category",
        data: trend.map((t) => t.label),
        axisLine: { lineStyle: { color: "#e8eef6" } },
        axisTick: { show: false },
        axisLabel: { color: "#94a3b8", fontSize: 12 },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: "#f1f5f9" } },
        axisLabel: { color: "#94a3b8", fontSize: 12, formatter: (v: number) => (v >= 10000 ? v / 10000 + "万" : String(v)) },
      },
      series: [
        {
          name: "签约金额",
          type: "bar",
          data: trend.map((t) => t.amount),
          itemStyle: { color: "#1668dc", borderRadius: [6, 6, 0, 0] },
          barMaxWidth: 46,
        },
      ],
    }),
    [trend],
  );

  const cols = (label: string) => [
    { title: label, dataIndex: "name" },
    {
      title: "签约笔数",
      dataIndex: "count",
      width: 110,
      sorter: (a: Agg, b: Agg) => a.count - b.count,
    },
    {
      title: "签约金额",
      dataIndex: "amount",
      width: 160,
      defaultSortOrder: "descend" as const,
      sorter: (a: Agg, b: Agg) => a.amount - b.amount,
      render: (v: number) => <span style={{ fontWeight: 500 }}>{money(v)}</span>,
    },
  ];

  const avg = total.count > 0 ? Math.round(total.amount / total.count) : 0;
  const best = trend.reduce<Bucket | null>((m, t) => (!m || t.amount > m.amount ? t : m), null);

  const empty = { emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无签约数据" /> };

  return (
    <>
      <PageHead
        icon={<BarChartOutlined />}
        title="数据复盘"
        subtitle="签约业绩按周期与维度拆解"
        tag="报表分析"
        tagNote="月度、季度、年度业绩一目了然"
        extra={
          <Space>
            <Select
              value={year}
              style={{ width: 110 }}
              onChange={(v) => go({ year: v })}
              options={yearOptions.map((y) => ({ value: y, label: `${y} 年` }))}
            />
            <Segmented
              value={period}
              onChange={(v) => go({ period: String(v) })}
              options={[
                { label: "月度", value: "month" },
                { label: "季度", value: "quarter" },
                { label: "年度", value: "year" },
              ]}
            />
          </Space>
        }
      />

      {aiEnabled && <AskDataCard />}

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <StatCard icon={<PayCircleOutlined />} color="#1668dc" label={`${year} 年签约总额`} value={money(total.amount)} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatCard icon={<FileDoneOutlined />} color="#22c55e" label="签约笔数" value={total.count} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatCard icon={<RiseOutlined />} color="#f59e0b" label="客单价" value={avg > 0 ? money(avg) : "—"} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatCard
            icon={<BarChartOutlined />}
            color="#8b5cf6"
            label="最佳周期"
            value={best ? best.label : "—"}
            deltaLabel={best ? money(best.amount) : ""}
          />
        </Col>
      </Row>

      <Card style={{ marginTop: 16 }} title={<span className="section-title">签约金额趋势</span>}>
        {trend.length ? (
          <Chart option={trendOption} height={320} />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该年度暂无签约记录" style={{ padding: "60px 0" }} />
        )}
      </Card>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={12}>
          <Card title={<span className="section-title">按销售负责人</span>} styles={{ body: { paddingTop: 8 } }}>
            <Table size="small" rowKey="id" dataSource={bySales} columns={cols("销售负责人")} pagination={false} locale={empty} />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title={<span className="section-title">按渠道负责人</span>} styles={{ body: { paddingTop: 8 } }}>
            <Table size="small" rowKey="id" dataSource={byChannelOwner} columns={cols("渠道负责人")} pagination={false} locale={empty} />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card
            title={<span className="section-title">按来源渠道</span>}
            extra={<Typography.Text type="secondary" style={{ fontSize: 13 }}>推荐链最顶端的渠道</Typography.Text>}
            styles={{ body: { paddingTop: 8 } }}
          >
            <Table size="small" rowKey="id" dataSource={byChannel} columns={cols("来源渠道")} pagination={false} locale={empty} />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card
            title={<span className="section-title">按渠道归属</span>}
            extra={<Typography.Text type="secondary" style={{ fontSize: 13 }}>推荐链往上两代</Typography.Text>}
            styles={{ body: { paddingTop: 8 } }}
          >
            <Table size="small" rowKey="id" dataSource={byAttribution} columns={cols("归属对象")} pagination={false} locale={empty} />
          </Card>
        </Col>
      </Row>
    </>
  );
}
