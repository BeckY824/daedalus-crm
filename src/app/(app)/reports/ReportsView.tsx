"use client";

import { useMemo, useState } from "react";
import { palette, categorical } from "@/lib/palette";
import { Card, Row, Col, Table, Typography, Drawer } from "antd";
import { BarChartOutlined, PayCircleOutlined, FileDoneOutlined, RiseOutlined } from "@ant-design/icons";
import Link from "next/link";
import type { EChartsCoreOption } from "echarts/core";
import Chart from "@/components/Chart";
import { StatCard } from "@/components/ui";
import EmptyState, { 表格空态 } from "@/components/EmptyState";
import { money, fmtDate } from "@/lib/utils";
import type { Agg, Bucket, 明细行 } from "../overview/data";
import { useBusiness } from "@/lib/business-client";

/**
 * 回看视图（本月 / 本年）的正文：总额、趋势、四个维度的拆解。
 *
 * 页头、视图切换、问数据的框都在「数据」页的壳里（overview/DataShell），
 * 这一份只画数——同一份正文两个时间段共用，不再有 `/reports` 那一套
 * 自己的年份下拉和月/季/年切换（三处看数、两个问答框的来路就是它）。
 */
export default function ReportsView({
  trend, 明细, bySales, byChannelOwner, byChannel, byAttribution, total, 口径,
}: {
  trend: Bucket[];
  明细: Record<string, 明细行[]>;
  bySales: Agg[];
  byChannelOwner: Agg[];
  byChannel: Agg[];
  byAttribution: Agg[];
  total: { amount: number; count: number };
  /** 这一页的数是按什么口径算的。数字必须说得清自己是怎么来的 */
  口径: string;
}) {
  const b = useBusiness();
  /**
   * 点开的是哪一根柱子。设计稿 09/DATA·YEAR 的页面规则「图表提供查看明细」——
   * 一张只能看不能问的趋势图，看出「三月特别高」之后就断了：
   * 到底是一单大的还是十单小的，得退出去自己翻。
   * 明细跟着数据一起送下来了（见 overview/data.ts），所以点开是即时的，不再跑一趟服务器。
   */
  const [开着的, set开着的] = useState<string | null>(null);
  const 这一段 = 开着的 ? (明细[开着的] ?? []) : [];
  const 这一段金额 = 这一段.reduce((s2, r) => s2 + r.金额, 0);

  const trendOption: EChartsCoreOption = useMemo(
    () => ({
      tooltip: {
        trigger: "axis",
        backgroundColor: palette.panel,
        borderColor: palette.lineSoft,
        textStyle: { color: palette.inkSoft, fontSize: 12 },
        extraCssText: "box-shadow:0 6px 20px rgba(16,43,77,.12);border-radius:8px;",
        valueFormatter: (v: number) => "¥ " + v.toLocaleString(),
      },
      grid: { left: 8, right: 12, top: 30, bottom: 4, containLabel: true },
      xAxis: {
        type: "category",
        // 横轴刻度也能点：矮柱子点不中的时候，点它下面那个日期同样打开明细
        triggerEvent: true,
        data: trend.map((t) => t.label),
        axisLine: { lineStyle: { color: palette.lineSoft } },
        axisTick: { show: false },
        axisLabel: { color: palette.textMuted, fontSize: 12 },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: palette.lineSoft } },
        axisLabel: { color: palette.textMuted, fontSize: 12, formatter: (v: number) => (v >= 10000 ? v / 10000 + "万" : String(v)) },
      },
      series: [
        {
          name: "签约金额",
          type: "bar",
          data: trend.map((t) => t.amount),
          itemStyle: { color: palette.brand, borderRadius: [6, 6, 0, 0] },
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
          <StatCard icon={<PayCircleOutlined />} color={palette.brand} label="签约总额" value={money(total.amount)} note={口径} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatCard icon={<FileDoneOutlined />} color={categorical.green} label="签约笔数" value={total.count} note={口径} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatCard icon={<RiseOutlined />} color={categorical.amber} label="客单价" value={avg > 0 ? money(avg) : "—"} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatCard
            icon={<BarChartOutlined />}
            color={categorical.violet}
            label="最佳周期"
            value={best ? best.label : "—"}
            deltaLabel={best ? money(best.amount) : ""}
          />
        </Col>
      </Row>

      {/* 没有数据时不画那条一路为 0 的线——假的走势比没有走势更糟 */}
      <Card
        style={{ marginTop: 16 }}
        title={<span className="section-title">签约金额趋势</span>}
        extra={trend.length ? <Typography.Text type="secondary" style={{ fontSize: 13 }}>点柱子或下面的日期，看这一段签了哪几笔</Typography.Text> : null}
      >
        {trend.length ? (
          <Chart option={trendOption} height={320} 点一段={(i) => set开着的(trend[i]?.label ?? null)} />
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

      <Drawer
        open={开着的 !== null}
        onClose={() => set开着的(null)}
        /* antd 6 里 Drawer 的 width 废了，宽度改在 wrapper 上给（和记录页那两个抽屉一致） */
        styles={{ wrapper: { width: 520 } }}
        title={开着的 ? `${开着的} · 签约明细` : ""}
      >
        <div style={{ marginBottom: 12, color: "var(--text-muted)", fontSize: "var(--fs-note)" }}>
          共 {这一段.length} 笔 · {money(这一段金额)}
        </div>
        <Table<明细行>
          rowKey="id"
          size="small"
          dataSource={这一段}
          pagination={false}
          locale={表格空态({ title: "这一段没有签约", hint: "换一根柱子看看。", demo: false })}
          columns={[
            {
              title: b.customer,
              dataIndex: "学员",
              render: (v: string, r) => (
                <Link href={`/customers/${r.学员id}`} className="link-strong">
                  {v}
                </Link>
              ),
            },
            { title: "销售", dataIndex: "销售", width: 110 },
            { title: "签约日", dataIndex: "日期", width: 110, render: (v: string) => <span className="muted nowrap">{fmtDate(v)}</span> },
            {
              title: "金额",
              dataIndex: "金额",
              width: 120,
              align: "right" as const,
              render: (v: number) => <span style={{ fontWeight: 500 }}>{money(v)}</span>,
            },
          ]}
        />
      </Drawer>
    </>
  );
}
