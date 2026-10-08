"use client";

import { useMemo, useState } from "react";
import { palette, categorical } from "@/lib/palette";
import { Card, Row, Col, Table, Typography, Drawer, Segmented } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { BarChartOutlined, PayCircleOutlined, FileDoneOutlined, RiseOutlined } from "@ant-design/icons";
import Link from "next/link";
import type { EChartsCoreOption } from "echarts/core";
import Chart from "@/components/Chart";
import { StatCard } from "@/components/ui";
import EmptyState, { 表格空态 } from "@/components/EmptyState";
import { fmtDate } from "@/lib/utils";
import { 金额, 币种名, 合计文字, type 币种合计 } from "@/lib/currency";
import type { Agg, Bucket } from "../overview/data";
import { 按人明细, type 明细行 } from "../overview/drill";
import { useBusiness } from "@/lib/business-client";
import { 签约叫, 外贸精简, 外贸订单 } from "@/lib/business-config";

/**
 * 回看视图（本月 / 本年）的正文：总额、趋势、四个维度的拆解。
 *
 * 页头、视图切换、问数据的框都在「数据」页的壳里（overview/DataShell），
 * 这一份只画数——同一份正文两个时间段共用，不再有 `/reports` 那一套
 * 自己的年份下拉和月/季/年切换（三处看数、两个问答框的来路就是它）。
 */
export default function ReportsView({
  trend, 明细, bySales, byChannelOwner, byChannel, byAttribution, total, 未来, 口径, 单人 = false, 币种, 币种们,
}: {
  trend: Bucket[];
  明细: Record<string, 明细行[]>;
  bySales: Agg[];
  byChannelOwner: Agg[];
  byChannel: Agg[];
  byAttribution: Agg[];
  total: { amount: number; count: number };
  未来?: { amount: number; count: number };
  /** 这一页的数只算这一种币（2026-10-03，不换汇）；币种们 = 这一段每种币各签了多少 */
  币种: string;
  币种们: 币种合计[];
  /** 这一页的数是按什么口径算的。数字必须说得清自己是怎么来的 */
  口径: string;
  /**
   * 库里只有一个人：「按销售负责人」「按渠道负责人」两张表不摆（审查 D2）——
   * 每张都只有一行，就是你自己，数和上面的合计一模一样
   */
  单人?: boolean;
}) {
  const b = useBusiness();
  /*
    外贸（2026-10-06 F.3）：签约就是订单——卡片、表头、空态、明细都说「订单」；渠道和推荐链外贸不摆，
    「按渠道负责人 / 来源渠道 / 渠道归属」三张表整块不出（外贸的来源记在客户自己的来源格里）
  */
  const 叫 = 签约叫(b);
  const 外贸 = 外贸精简(b);
  const 去标 = 外贸订单(b) ? "先去商机里把客户确认的转为订单" : "先去商机里把赢单的标出来";
  const router = useRouter();
  const sp = useSearchParams();
  const money = (n: number) => 金额(n, 币种);
  /** 换一种币看：只改网址上的 currency，别的（本月 / 本年）不动 */
  const 换币 = (码: string) => {
    const q = new URLSearchParams(sp.toString());
    q.set("currency", 码);
    router.push(`/overview?${q.toString()}`);
  };
  /**
   * 点开的是哪一根柱子。设计稿 09/DATA·YEAR 的页面规则「图表提供查看明细」——
   * 一张只能看不能问的趋势图，看出「三月特别高」之后就断了：
   * 到底是一单大的还是十单小的，得退出去自己翻。
   * 明细跟着数据一起送下来了（见 overview/data.ts），所以点开是即时的，不再跑一趟服务器。
   */
  const [开着的, set开着的] = useState<string | null>(null);
  /**
   * 「按销售 / 渠道负责人」点开的那个人（T-030）。原来跳客户列表按现在的负责人、不限时间，
   * 和这一行（签约那一刻的负责人、这一段、这一种币）对不上；现在就地看这个人这一段签的那几笔
   */
  const [开着的人, set开着的人] = useState<{ 维度: "销售" | "渠道负责人"; id: string; name: string } | null>(null);
  const 这一段 = 开着的人 ? 按人明细(明细, 开着的人.维度, 开着的人.id) : 开着的 ? (明细[开着的] ?? []) : [];
  const 这一段金额 = 这一段.reduce((s2, r) => s2 + r.金额, 0);
  const 关抽屉 = () => {
    set开着的(null);
    set开着的人(null);
  };

  const trendOption: EChartsCoreOption = useMemo(
    () => ({
      tooltip: {
        trigger: "axis",
        backgroundColor: palette.panel,
        borderColor: palette.lineSoft,
        textStyle: { color: palette.inkSoft, fontSize: 12 },
        extraCssText: "box-shadow:0 6px 20px rgba(16,43,77,.12);border-radius:8px;",
        valueFormatter: (v: number) => 金额(v, 币种),
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
          name: `${叫}金额`,
          type: "bar",
          data: trend.map((t) => t.amount),
          itemStyle: { color: palette.brand, borderRadius: [6, 6, 0, 0] },
          barMaxWidth: 46,
        },
      ],
    }),
    [trend, 币种, 叫],
  );

  /**
   * 明细的去处：按销售 / 渠道负责人拆出来的那两张表，点名字就地打开这个人这一段签的那几笔
   * （T-030，原来跳客户列表、口径对不上）——「这 12 万是哪几位签的」得有地方看。
   * 来源渠道和归属两张表没有记签约那一刻的值，就不假装能点。
   */
  const cols = (label: string, 维度?: "销售" | "渠道负责人") => [
    {
      title: label,
      dataIndex: "name",
      render: (v: string, r: Agg) =>
        维度 && r.id !== "__none__" ? (
          <button type="button" className="link-strong link-plain" onClick={() => { set开着的(null); set开着的人({ 维度, id: r.id, name: v }); }}>
            {v}
          </button>
        ) : (
          v
        ),
    },
    {
      title: `${叫}笔数`,
      dataIndex: "count",
      width: 110,
      sorter: (a: Agg, b: Agg) => a.count - b.count,
    },
    {
      title: `${叫}金额`,
      dataIndex: "amount",
      width: 160,
      defaultSortOrder: "descend" as const,
      sorter: (a: Agg, b: Agg) => a.amount - b.amount,
      render: (v: number) => <span style={{ fontWeight: 500 }}>{money(v)}</span>,
    },
  ];

  /**
   * 客单价 = 总额 ÷ **签约的人数**，不是 ÷ 笔数。
   *
   * 原来除的是 `total.count`（签约笔数）。同一位学员续费、补课会签好几笔
   * （schema 里 Contract 的注释就写着「同一学员可多次签约」），
   * 那时算出来的是「每笔均价」，比真正的客单价低——而卡片上写的是「客单价」。
   * 人数从明细里数：明细已经按桶分好了，摊平取 id 去重即可，不用再查一趟库。
   */
  const 签约人数 = new Set(Object.values(明细).flat().map((r) => r.学员id)).size;
  const avg = 签约人数 > 0 ? Math.round(total.amount / 签约人数) : 0;
  /*
    2026-09-19 起横轴上没签约的日子也占一个刻度（值为 0，见 overview/data.ts），
    所以「一条签约都没有」不能再看 trend 是不是空的了——它永远不空。
    best 也要挡一道：全是 0 的时候挑出来的「最佳周期」会是第一根柱子，
    界面上就成了「最佳周期 09-01 · ¥0」，一个不存在的结论。
  */
  const 有签约 = total.count > 0;
  const best = 有签约 ? trend.reduce<Bucket | null>((m, t) => (!m || t.amount > m.amount ? t : m), null) : null;

  // 复盘的两张表：这一档没人时说清是「这个口径下没有」，不是「系统里没有」
  const empty = 表格空态({
    title: `这一档还没有${叫}`,
    hint: `按${叫}记录算。换一个时间段，或者${去标}。`,
    demo: false,
  });

  return (
    <>
      {未来 && 未来.count > 0 && <p className="muted">当前范围内有 {未来.count} 笔日期尚未到的{叫}（{money(未来.amount)}），未计入历史合计、趋势和最佳周期；可在对应客户记录中核对日期。</p>}
      {/*
        这一段签过两种以上的币：给一个切换，下面的卡、图、表都只算选中的那一种。
        不换汇——把美元和欧元折成一个数，汇率按哪天算都说不清，图上的走势就是假的。
      */}
      {币种们.length > 1 && (
        <div className="reports-cur">
          <span className="muted">按币种看</span>
          <Segmented
            size="small"
            value={币种}
            onChange={(v) => 换币(String(v))}
            options={币种们.map((x) => ({ value: x.币种, label: <span title={币种名(x.币种)}>{x.币种}</span> }))}
          />
          <span className="muted">这一段已发生的{叫}合计 {合计文字(币种们)}</span>
        </div>
      )}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <StatCard icon={<PayCircleOutlined />} color={palette.brand} label={`${叫}总额`} value={money(total.amount)} note={口径} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatCard icon={<FileDoneOutlined />} color={categorical.green} label={`${叫}笔数`} value={total.count} note={口径} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatCard
            icon={<RiseOutlined />}
            color={categorical.amber}
            label="客单价"
            value={avg > 0 ? money(avg) : "—"}
            note={签约人数 > 0 ? (外贸 ? `${签约人数} 位${b.customer}下了 ${total.count} 单` : `${签约人数} 位${b.customer}签了 ${total.count} 笔`) : undefined}
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatCard
            icon={<BarChartOutlined />}
            color={categorical.violet}
            label="最佳周期"
            value={best ? best.label : "—"}
            note={best ? money(best.amount) : undefined}
          />
        </Col>
      </Row>

      {/* 没有数据时不画那条一路为 0 的线——假的走势比没有走势更糟 */}
      <Card
        style={{ marginTop: 16 }}
        title={<span className="section-title">{叫}金额趋势</span>}
        extra={有签约 ? <Typography.Text type="secondary" style={{ fontSize: 13 }}>点柱子或下面的日期，看这一段{外贸 ? "下了哪几单" : "签了哪几笔"}</Typography.Text> : null}
      >
        {有签约 ? (
          <Chart option={trendOption} height={320} 点一段={(i) => { set开着的人(null); set开着的(trend[i]?.label ?? null); }} />
        ) : (
          <EmptyState
            title={`这一段还没有${叫}记录`}
            hint={`有了${叫}之后这里会按时间画出金额趋势。换一个时间段看看，或者${去标}。`}
            demo={false}
          />
        )}
      </Card>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {!单人 && (
          <>
            <Col xs={24} xl={12}>
              <Card title={<span className="section-title">按销售负责人</span>} styles={{ body: { paddingTop: 8 } }}>
                <Table size="small" rowKey="id" dataSource={bySales} columns={cols("销售负责人", "销售")} pagination={false} locale={empty} />
              </Card>
            </Col>
            {!外贸 && <Col xs={24} xl={12}>
              <Card title={<span className="section-title">按渠道负责人</span>} styles={{ body: { paddingTop: 8 } }}>
                <Table size="small" rowKey="id" dataSource={byChannelOwner} columns={cols("渠道负责人", "渠道负责人")} pagination={false} locale={empty} />
              </Card>
            </Col>}
          </>
        )}
        {!外贸 && <><Col xs={24} xl={12}>
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
        </Col></>}
      </Row>

      <Drawer
        open={开着的 !== null || 开着的人 !== null}
        onClose={关抽屉}
        /* antd 6 里 Drawer 的 width 废了，宽度改在 wrapper 上给（和记录页那两个抽屉一致） */
        styles={{ wrapper: { width: 520 } }}
        title={开着的人 ? `${开着的人.name} · ${叫}明细` : 开着的 ? `${开着的} · ${叫}明细` : ""}
      >
        {开着的人 && (
          // 页头写清口径（T-030）：和上面那一行同一个算法；要看他现在手上的客户，给一条去客户列表的路
          <div style={{ marginBottom: 8, fontSize: "var(--fs-note)" }}>
            按{外贸 ? "下单" : "签约"}那一刻的{开着的人.维度 === "销售" ? "销售负责人" : "渠道负责人"}算，{口径}{币种们.length > 1 ? `，只算 ${币种}` : ""}——和上面那一行同一个口径。
            {" "}
            <Link href={`/customers?${开着的人.维度 === "销售" ? "salesOwnerId" : "channelOwnerId"}=${开着的人.id}`}>
              看他现在负责的全部{b.customer} ›
            </Link>
          </div>
        )}
        <div style={{ marginBottom: 12, color: "var(--text-muted)", fontSize: "var(--fs-note)" }}>
          共 {这一段.length} 笔 · {money(这一段金额)}
          {开着的人 && ` · ${new Set(这一段.map((r) => r.学员id)).size} 位${b.customer}`}
        </div>
        <Table<明细行>
          rowKey="id"
          size="small"
          dataSource={这一段}
          pagination={false}
          locale={表格空态({ title: `这一段没有${叫}`, hint: 开着的人 ? "换一个时间段看看。" : "换一根柱子看看。", demo: false })}
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
            { title: 外贸 ? "确认日" : "签约日", dataIndex: "日期", width: 110, render: (v: string) => <span className="muted nowrap">{fmtDate(v)}</span> },
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
