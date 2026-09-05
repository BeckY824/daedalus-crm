"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Row, Col, Card, Segmented, Typography, Space, Tag, Empty, Select } from "antd";
import {
  TeamOutlined,
  UserOutlined,
  ThunderboltOutlined,
  PayCircleOutlined,
  UserAddOutlined,
  RiseOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import type { EChartsCoreOption } from "echarts/core";
import Chart, { Sparkline } from "@/components/Chart";
import { StatCard, CompanyLogo, UserCell } from "@/components/ui";
import SentinelCard from "./SentinelCard";
import type { WatchItem } from "@/lib/sentinel";
import { money, moneyShort, smartTime, 成员选项 } from "@/lib/utils";
import { OPP_STAGE_COLOR } from "@/lib/constants";

type Props = {
  stats: {
    leadTotal: number;
    leadDelta: number;
    activeCustomers: number;
    activeDelta: number;
    oppThisMonth: number;
    oppDelta: number;
    forecast: number;
    newCustomersThisMonth: number;
    newCustomersDelta: number;
    oppTotalAmount: number;
    winRate: number;
    /** 卡片下方小曲线的真实数据，按最近 8 周 */
    newCustomerSeries: number[];
    oppAmountSeries: number[];
    winRateSeries: number[];
  };
  trend: { label: string; created: number; active: number }[];
  /**
   * 漏斗按时间窗给两份：前四档（进行中）两份相同，只有末档「赢单成交」不同。
   * 两份都在服务端算好一起送下来，切换窗口不用再跑一趟服务器。
   */
  funnel: Record<"本月" | "本季", { stage: string; count: number; amount: number }[]>;
  ranking: { id: string; name: string; email: string; amount: number }[];
  tasks: { id: string; title: string; customerId: string; customerName: string; dueAt: string | null }[];
  watchlist: WatchItem[];
  /** 服务端是否配置了 AI。没配时盯盘照常显示，只是没有「起草跟进」按钮 */
  aiEnabled: boolean;
};

export default function DashboardView({ stats, trend, funnel, ranking, tasks, watchlist, aiEnabled }: Props) {
  // 这个下拉原本没有接线，选了没反应，而卡片上又写着「本月」——比没有更误导
  const [窗口, set窗口] = useState<"本月" | "本季">("本月");
  const [range, setRange] = useState<string | number>("近30天");

  const sliced = useMemo(() => {
    const n = range === "近7天" ? 7 : range === "近90天" ? trend.length : 30;
    return trend.slice(-n);
  }, [range, trend]);

  const trendOption: EChartsCoreOption = useMemo(
    () => ({
      tooltip: {
        trigger: "axis",
        backgroundColor: "#fff",
        borderColor: "#e6edf6",
        textStyle: { color: "#334155", fontSize: 12 },
        extraCssText: "box-shadow:0 6px 20px rgba(16,43,77,.12);border-radius:8px;",
      },
      legend: {
        data: ["新增客户", "活跃客户"],
        left: 0,
        top: 0,
        icon: "circle",
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: "#64748b", fontSize: 12 },
      },
      grid: { left: 4, right: 10, top: 40, bottom: 4, containLabel: true },
      xAxis: {
        type: "category",
        data: sliced.map((d) => d.label),
        boundaryGap: false,
        axisLine: { lineStyle: { color: "#e8eef6" } },
        axisTick: { show: false },
        axisLabel: { color: "#94a3b8", fontSize: 11, interval: Math.floor(sliced.length / 6) },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: "#f1f5f9" } },
        axisLabel: { color: "#94a3b8", fontSize: 11 },
      },
      series: [
        {
          name: "新增客户",
          type: "line",
          smooth: true,
          symbolSize: 5,
          data: sliced.map((d) => d.created),
          itemStyle: { color: "#1668dc" },
          lineStyle: { width: 2 },
        },
        {
          name: "活跃客户",
          type: "line",
          smooth: true,
          symbolSize: 5,
          data: sliced.map((d) => d.active),
          itemStyle: { color: "#22c55e" },
          lineStyle: { width: 2 },
          areaStyle: {
            color: {
              type: "linear",
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: "rgba(34,197,94,.22)" },
                { offset: 1, color: "rgba(34,197,94,0)" },
              ],
            },
          },
        },
      ],
    }),
    [sliced],
  );

  const maxRank = Math.max(1, ...ranking.map((r) => r.amount));
  /** 榜单上两个同名的人必须能分辨，否则不知道这条业绩算谁的。口径与负责人下拉一致 */
  const 标签 = new Map(成员选项(ranking).map((o) => [o.value, o.label]));
  const 榜单 = ranking.map((r) => ({ ...r, 显示名: 标签.get(r.id) ?? r.name }));
  const 当前漏斗 = funnel[窗口];
  const funnelTotal = 当前漏斗.reduce((s, f) => s + f.count, 0);
  const funnelAmount = 当前漏斗.reduce((s, f) => s + f.amount, 0);
  const maxFunnel = Math.max(1, ...当前漏斗.map((f) => f.count));

  return (
    <>
      {/* 指标卡 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <StatCard icon={<TeamOutlined />} color="#1668dc" label="线索总数" value={stats.leadTotal.toLocaleString()} delta={stats.leadDelta} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatCard icon={<UserOutlined />} color="#22c55e" label="活跃客户数" value={stats.activeCustomers.toLocaleString()} delta={stats.activeDelta} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatCard icon={<ThunderboltOutlined />} color="#f59e0b" label="本月新增商机" value={stats.oppThisMonth.toLocaleString()} delta={stats.oppDelta} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          {/* 这里原本写死 delta={18.6}：零数据时也显示「较上月 ↑ 18.6%」。
                数据首页上的假数字比没有数字更糟——人会拿它做判断。
                没有可比口径就不显示涨跌，只说明算法。 */}
          <StatCard
            icon={<PayCircleOutlined />}
            color="#8b5cf6"
            label="预测销售额"
            value={money(stats.forecast)}
            note="进行中商机按成交概率加权"
          />
        </Col>
      </Row>

      {/* 盯盘提醒：没有信号时整卡不出现，首页不该有一块常驻的空提醒 */}
      {watchlist.length > 0 && <SentinelCard items={watchlist} aiEnabled={aiEnabled} />}

      {/* 趋势 + 排行 */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={15}>
          <Card
            styles={{ body: { paddingTop: 14 } }}
            title={<span className="section-title">客户趋势分析</span>}
            extra={
              <Segmented
                size="small"
                value={range}
                onChange={setRange}
                options={["近7天", "近30天", "近90天"]}
              />
            }
          >
            <Chart option={trendOption} height={320} />
          </Card>
        </Col>

        <Col xs={24} xl={9}>
          <Row gutter={[16, 16]}>
            <Col span={24}>
              <Card
                title={<span className="section-title">销售团队业绩排行</span>}
                styles={{ body: { paddingTop: 10 } }}
              >
                {ranking.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />}
                {/* key 必须用 id：成员姓名允许重复，用 name 会撞 key，React 会把两行合并或漏掉 */}
                {榜单.map((r, i) => (
                  <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0" }}>
                    <span
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: "50%",
                        display: "grid",
                        placeItems: "center",
                        fontSize: 13,
                        fontWeight: 600,
                        flex: "none",
                        color: i < 3 ? "#fff" : "#64748b",
                        background: ["#f59e0b", "#94a3b8", "#d97706"][i] ?? "#f1f5f9",
                      }}
                    >
                      {i + 1}
                    </span>
                    {/* 原本固定 92px 且不裁剪：姓名超过三个字（英文更早）就会溢出，
                        压在后面的进度条上。给足宽度并明确裁剪 */}
                    <div style={{ width: 120, flex: "none", minWidth: 0, overflow: "hidden" }}>
                      <UserCell name={r.显示名} size={28} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          height: 9,
                          borderRadius: 5,
                          background: "#1668dc",
                          width: `${Math.max(6, (r.amount / maxRank) * 100)}%`,
                        }}
                      />
                    </div>
                    <span style={{ fontSize: 14, color: "#64748b", width: 78, textAlign: "right", flex: "none" }}>
                      {r.amount.toLocaleString()}
                    </span>
                  </div>
                ))}
              </Card>
            </Col>

            <Col xs={24} sm={12} xl={24}>
              <Card styles={{ body: { padding: 20 } }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <Space size={8}>
                      <span className="stat-icon" style={{ width: 38, height: 38, fontSize: 18, background: "#f59e0b1f", color: "#f59e0b" }}>
                        <RiseOutlined />
                      </span>
                      <Typography.Text type="secondary" style={{ fontSize: 15 }}>
                        商机总金额（进行中）
                      </Typography.Text>
                    </Space>
                    <div className="stat-value" style={{ marginTop: 8 }}>{money(stats.oppTotalAmount)}</div>
                  </div>
                  <div style={{ width: 130 }}>
                    <Sparkline data={stats.oppAmountSeries} color="#1668dc" height={52} />
                  </div>
                </div>
              </Card>
            </Col>
          </Row>
        </Col>
      </Row>

      {/* 待办 + 漏斗 + 小卡片 */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={9}>
          <Card
            title={<span className="section-title">近期跟进任务</span>}
            extra={<Link href="/follow-ups/plans" style={{ fontSize: 15 }}>查看全部</Link>}
            styles={{ body: { paddingTop: 8 } }}
          >
            {tasks.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待办任务" />}
            {tasks.map((t) => (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 0", borderBottom: "1px dashed #eef2f7" }}>
                <CompanyLogo name={t.customerName} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.title}
                  </div>
                  <Link href={`/customers/${t.customerId}`} style={{ fontSize: 14, color: "#94a3b8" }}>
                    {t.customerName}
                  </Link>
                </div>
                <span style={{ fontSize: 14, color: "#64748b", flex: "none" }}>{smartTime(t.dueAt)}</span>
                <Tag color="orange" style={{ margin: 0, borderRadius: 6, flex: "none" }}>待处理</Tag>
              </div>
            ))}
          </Card>
        </Col>

        <Col xs={24} xl={9}>
          <Card
            title={<span className="section-title">商机管道</span>}
            extra={
              <Select
                size="small"
                value={窗口}
                onChange={(v) => set窗口(v)}
                style={{ width: 84 }}
                options={[{ value: "本月" }, { value: "本季" }]}
              />
            }
            styles={{ body: { paddingTop: 12 } }}
          >
            {当前漏斗.map((f) => (
              <div key={f.stage} className="funnel-row">
                <span className="funnel-dot" style={{ background: OPP_STAGE_COLOR[f.stage] }} />
                <span style={{ width: 82, flex: "none" }}>{f.stage}</span>
                <span style={{ width: 48, flex: "none", color: "#64748b" }}>{f.count}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      height: 19,
                      borderRadius: 5,
                      background: OPP_STAGE_COLOR[f.stage],
                      opacity: 0.85,
                      width: `${Math.max(8, (f.count / maxFunnel) * 100)}%`,
                    }}
                  />
                </div>
                <span style={{ fontSize: 14, color: "#64748b", width: 104, textAlign: "right", flex: "none" }}>
                  {money(f.amount)}
                </span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14, paddingTop: 12, borderTop: "1px solid #eef2f7", fontSize: 15 }}>
              <span className="muted">合计</span>
              <Space size={20}>
                <span style={{ fontWeight: 500 }}>{funnelTotal}</span>
                <span style={{ fontWeight: 600 }}>{money(funnelAmount)}</span>
              </Space>
            </div>
            {/* 口径不写清楚的话，前四档和末档不是一个东西这件事没人看得出来 */}
            <div className="stat-delta" style={{ marginTop: 8 }}>
              前四档为当前进行中的商机；「赢单成交」为{窗口}已赢单的数量与金额
            </div>
          </Card>
        </Col>

        <Col xs={24} xl={6}>
          <Row gutter={[16, 16]}>
            <Col span={24}>
              <Card styles={{ body: { padding: 20 } }}>
                <Space size={8}>
                  <span className="stat-icon" style={{ width: 38, height: 38, fontSize: 18, background: "#22c55e1f", color: "#22c55e" }}>
                    <UserAddOutlined />
                  </span>
                  <Typography.Text type="secondary" style={{ fontSize: 15 }}>新增客户（本月）</Typography.Text>
                </Space>
                <div className="stat-value" style={{ marginTop: 8 }}>{stats.newCustomersThisMonth}</div>
                {/* 原本写死 ↑ 和绿色，还用 Math.abs 把负数也显示成上升——
                    下降会被显示成增长，这是会误导决策的 */}
                <div className="stat-delta">
                  较上月{" "}
                  {stats.newCustomersDelta === 0 ? (
                    "持平"
                  ) : (
                    <span
                      style={{
                        color: stats.newCustomersDelta > 0 ? "#16a34a" : "#dc2626",
                        fontWeight: 500,
                      }}
                    >
                      {stats.newCustomersDelta > 0 ? "↑" : "↓"} {Math.abs(stats.newCustomersDelta)}%
                    </span>
                  )}
                </div>
                <Sparkline data={stats.newCustomerSeries} color="#22c55e" height={52} />
              </Card>
            </Col>
            <Col span={24}>
              <Card styles={{ body: { padding: 20 } }}>
                <Space size={8}>
                  <span className="stat-icon" style={{ width: 38, height: 38, fontSize: 18, background: "#8b5cf61f", color: "#8b5cf6" }}>
                    <SafetyCertificateOutlined />
                  </span>
                  <Typography.Text type="secondary" style={{ fontSize: 15 }}>商机赢单率</Typography.Text>
                </Space>
                <div className="stat-value" style={{ marginTop: 8 }}>{stats.winRate}%</div>
                <div className="stat-delta">
                  基于已关闭商机统计
                </div>
                <Sparkline data={stats.winRateSeries} color="#8b5cf6" height={52} />
              </Card>
            </Col>
          </Row>
        </Col>
      </Row>
      <div style={{ height: 4 }} />
      <Typography.Text type="secondary" style={{ fontSize: 14 }}>
        预测销售额 = Σ(进行中商机金额 × 成交概率)，共 {moneyShort(stats.oppTotalAmount)} 元在管道中。
      </Typography.Text>
    </>
  );
}
