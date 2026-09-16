"use client";

import { useMemo } from "react";
import { Card, Row, Col, Table, Typography } from "antd";
import { BarChartOutlined, PayCircleOutlined, FileDoneOutlined, RiseOutlined } from "@ant-design/icons";
import Link from "next/link";
import type { EChartsCoreOption } from "echarts/core";
import Chart from "@/components/Chart";
import { StatCard } from "@/components/ui";
import EmptyState, { 表格空态 } from "@/components/EmptyState";
import { money } from "@/lib/utils";
import type { Agg, Bucket } from "../overview/data";

/**
 * 回看视图（本月 / 本年）的正文：总额、趋势、四个维度的拆解。
 *
 * 页头、视图切换、问数据的框都在「数据」页的壳里（overview/DataShell），
 * 这一份只画数——同一份正文两个时间段共用，不再有 `/reports` 那一套
 * 自己的年份下拉和月/季/年切换（三处看数、两个问答框的来路就是它）。
 */
export default function ReportsView({
  trend, bySales, byChannelOwner, byChannel, byAttribution, total, 口径,
}: {
  trend: Bucket[];
  bySales: Agg[];
  byChannelOwner: Agg[];
  byChannel: Agg[];
  byAttribution: Agg[];
  total: { amount: number; count: number };
  /** 这一页的数是按什么口径算的。数字必须说得清自己是怎么来的 */
  口径: string;
}) {

  const trendOption: EChartsCoreOption = useMemo(
    () => ({
      tooltip: {
        trigger: "axis",
        backgroundColor: "#fff",
        borderColor: "#e6edf6",
        textStyle: { color: "#374151", fontSize: 12 },
        extraCssText: "box-shadow:0 6px 20px rgba(16,43,77,.12);border-radius:8px;",
        valueFormatter: (v: number) => "¥ " + v.toLocaleString(),
      },
      grid: { left: 8, right: 12, top: 30, bottom: 4, containLabel: true },
      xAxis: {
        type: "category",
        data: trend.map((t) => t.label),
        axisLine: { lineStyle: { color: "#e8eef6" } },
        axisTick: { show: false },
        axisLabel: { color: "#6b7280", fontSize: 12 },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: "#f1f5f9" } },
        axisLabel: { color: "#6b7280", fontSize: 12, formatter: (v: number) => (v >= 10000 ? v / 10000 + "万" : String(v)) },
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

  /**
   * 明细的去处：按销售 / 渠道负责人拆出来的那两张表，点名字能落到
   * 学员列表对应的筛选上——「这 12 万是哪几位签的」得有地方看。
   * 来源渠道和归属两张表没有对应的筛选条件，就不假装能点。
   */
  const cols = (label: string, 明细?: (r: Agg) => string) => [
    {
      title: label,
      dataIndex: "name",
      render: (v: string, r: Agg) =>
        明细 && r.id !== "__none__" ? (
          <Link href={明细(r)} className="link-strong">
            {v}
          </Link>
        ) : (
          v
        ),
    },
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

  // 复盘的两张表：这一档没人时说清是「这个口径下没有」，不是「系统里没有」
  const empty = 表格空态({
    title: "这一档还没有签约",
    hint: "按签约记录算。换一个时间段，或者先去商机里把赢单的标出来。",
    demo: false,
  });

  return (
    <>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <StatCard icon={<PayCircleOutlined />} color="#1668dc" label="签约总额" value={money(total.amount)} note={口径} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatCard icon={<FileDoneOutlined />} color="#22c55e" label="签约笔数" value={total.count} note={口径} />
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

      {/* 没有数据时不画那条一路为 0 的线——假的走势比没有走势更糟 */}
      <Card style={{ marginTop: 16 }} title={<span className="section-title">签约金额趋势</span>}>
        {trend.length ? (
          <Chart option={trendOption} height={320} />
        ) : (
          <EmptyState
            title="这一段还没有签约记录"
            hint="签约之后这里会按时间画出金额趋势。换一个时间段看看，或者先去商机里把赢单的标出来。"
            demo={false}
          />
        )}
      </Card>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={12}>
          <Card title={<span className="section-title">按销售负责人</span>} styles={{ body: { paddingTop: 8 } }}>
            <Table size="small" rowKey="id" dataSource={bySales} columns={cols("销售负责人", (r) => `/customers?salesOwnerId=${r.id}`)} pagination={false} locale={empty} />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title={<span className="section-title">按渠道负责人</span>} styles={{ body: { paddingTop: 8 } }}>
            <Table size="small" rowKey="id" dataSource={byChannelOwner} columns={cols("渠道负责人", (r) => `/customers?channelOwnerId=${r.id}`)} pagination={false} locale={empty} />
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
