"use client";

import Link from "next/link";
import { Table } from "antd";
import { DollarOutlined, FireOutlined, ImportOutlined, ExportOutlined, ThunderboltOutlined } from "@ant-design/icons";
import Chart from "@/components/Chart";
import { 站内, 页头, LinkPending } from "../OpsShell";
import { Kpi, 卡片, 按天柱图, 横条图, 千分位 } from "../ui";

type 榜条 = { kind: string; id: string; 名: string | null; 次数: number; token: number };

/**
 * 模型用量。四块：顶上几个总数（配了单价才有钱那一格）→ 每天的调用 → 按功能、按模型 →
 * 烧得最多的前 10（桌面端账号点得进详情）。
 */
export default function UsageView({
  token,
  合计,
  单价,
  按天,
  按模型,
  功能,
  榜,
}: {
  token: string;
  合计: { 次数: number; 入: number; 出: number };
  单价: { 入: number; 出: number } | null;
  按天: { 日: string; 数: number; token: number }[];
  按模型: { model: string; 次数: number; 入: number; 出: number }[];
  功能: { 功能: string; 次数: number; token: number }[];
  榜: 榜条[];
}) {
  const 平均 = 合计.次数 ? Math.round((合计.入 + 合计.出) / 合计.次数) : 0;
  const 钱 = 单价 ? (合计.入 * 单价.入 + 合计.出 * 单价.出) / 1e6 : null;

  return (
    <>
      <页头 标题="模型用量" 说明="近 30 天。这份数据只能随时间攒、补不回来——从 0.44.0 起才开始记" />

      <div className="opx-kpis">
        <Kpi 名="调用" icon={<ThunderboltOutlined />} 数={合计.次数} 尾="次" 注={合计.次数 ? `平均一次 ${千分位(平均)} token` : "还没有记录"} />
        <Kpi 名="输入 token" icon={<ImportOutlined />} 数={合计.入} 注="发给模型的" />
        <Kpi 名="输出 token" icon={<ExportOutlined />} 数={合计.出} 注="模型写回来的" />
        {钱 != null ? (
          <Kpi 名="花费（按配的单价）" icon={<DollarOutlined />} 数={`¥${钱.toFixed(2)}`} 注={`平均一次 ¥${(钱 / Math.max(1, 合计.次数)).toFixed(4)}`} />
        ) : (
          <Kpi 名="花费" icon={<DollarOutlined />} 数="—" 静 注="没配单价：填 LLM_PRICE_IN / OUT 后整段重算" />
        )}
      </div>

      <卡片 标题="每天的调用" 说明="悬停看 token">
        <Chart option={按天柱图(按天)} height={240} />
      </卡片>

      <div className="opx-grid opx-grid-11">
        <卡片 标题="按功能">
          {功能.length ? (
            <Chart option={横条图(功能.map((f) => ({ 名: f.功能, 数: f.次数 })))} height={Math.max(120, 功能.length * 30 + 10)} />
          ) : (
            <div className="opx-empty">这 30 天没有调用</div>
          )}
        </卡片>
        <卡片 标题="按模型">
          {按模型.length ? (
            <Chart option={横条图(按模型.map((m) => ({ 名: m.model, 数: m.次数 })))} height={Math.max(90, 按模型.length * 30 + 10)} />
          ) : (
            <div className="opx-empty">这 30 天没有调用</div>
          )}
        </卡片>
      </div>

      <卡片 标题="烧得最多" 说明="前 10，按 token" 平 style={{ marginTop: 14 }}>
        <Table<榜条>
          rowKey={(o) => `${o.kind}:${o.id}`}
          size="middle"
          dataSource={榜}
          pagination={false}
          locale={{ emptyText: <div className="opx-empty">这 30 天没有调用</div> }}
          columns={[
            {
              title: "是谁",
              render: (_, o) =>
                o.kind === "account" ? (
                  <Link href={站内(token, `/users/${o.id}`)} style={{ fontWeight: 500 }}><LinkPending />
                    {o.名 ?? `桌面端 …${o.id.slice(-8)}`}
                  </Link>
                ) : (
                  <span style={{ fontWeight: 500 }}>{o.名 ?? `工作区 …${o.id.slice(-8)}`}</span>
                ),
            },
            { title: "类型", width: 100, render: (_, o) => <span className={`opx-tag${o.kind === "account" ? " opx-tag-blue" : ""}`}>{o.kind === "account" ? "桌面端" : "工作区"}</span> },
            { title: "调用", width: 100, className: "num", render: (_, o) => 千分位(o.次数) },
            {
              title: "token",
              width: 140,
              className: "num",
              render: (_, o) => (
                <span>
                  <FireOutlined style={{ color: "var(--x-faint)", marginRight: 4 }} />
                  {千分位(o.token)}
                </span>
              ),
            },
          ]}
        />
      </卡片>
    </>
  );
}
