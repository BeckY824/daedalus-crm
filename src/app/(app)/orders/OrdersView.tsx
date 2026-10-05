"use client";

import Link from "next/link";
import { Select, Space, Tooltip } from "antd";
import { PageHead } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
import { useUrlFilters } from "@/lib/url-filters";
import { 成员选项, fmtDate, type 可选成员 } from "@/lib/utils";
import { 金额, 合计文字, 按币种合计 } from "@/lib/currency";
import { 节点名们, 节点灯 } from "@/lib/order";
import type { 订单行 } from "@/lib/order-db";
import { 订单节点 } from "@/lib/features";

/** 行名（登记给 AI 面板的那个）用客户名：问「Acme 那单」时 list_orders 按 customerName 查得到 */
type Row = 订单行;

/**
 * 订单一览：行是单，列是 12 个节点，格子按颜色说话——红 = 超期或卡住，黄 = 3 天内到期，绿 = 完成，灰 = 不适用。
 * 顶上一行按节点数「停在这一步几单、其中超期几单」：老板一眼看出卡在哪（外贸CRM模版.md 4.1 / 4.2）。
 * 点格子进订单、直接打开那一步。
 */
export default function OrdersView({ rows, users, filters }: { rows: 订单行[]; users: 可选成员[]; filters: { ownerId: string } }) {
  const { f, apply } = useUrlFilters("/orders", filters);
  const 行: Row[] = rows;

  /** 每个节点停了几单（当前节点是它）、其中几单超期 */
  const 停 = 节点名们.map((name, i) => {
    const 在这 = rows.filter((r) => r.当前?.idx === i + 1);
    return { idx: i + 1, name, 单: 在这.length, 超期: 在这.filter((r) => r.超期 > 0).length };
  }).filter((x) => x.单 > 0);
  const 结了 = rows.filter((r) => !r.当前).length;

  /*
    轻量的订单一览（2026-10-05 外贸客户建议，节点关着时）：客户要的列就是这几样——
    客户名称、订单号、付款方式、供应商名称、订单确认时间，再加金额和业务员。新确认的在前
  */
  const 轻列: 列<Row>[] = [
    {
      title: "订单号", key: "no", dataIndex: "no", width: 150, 常驻: true,
      render: (v: string, r) => <Link href={`/orders/${r.id}`} className="link-strong">{v}</Link>,
    },
    { title: "客户", key: "customerName", dataIndex: "customerName", width: 180, render: (v: string, r) => <Link href={`/customers/${r.customerId}`}>{v}</Link> },
    { title: "金额", key: "amount", dataIndex: "amount", width: 130, render: (v: number, r) => <span style={{ fontWeight: 600 }}>{金额(v, r.currency)}</span> },
    { title: "付款方式", key: "payment", dataIndex: "payment", width: 130, render: (v: string | null) => v ?? <span className="muted">—</span> },
    { title: "供应商", key: "supplier", dataIndex: "supplier", width: 160, render: (v: string | null) => v ?? <span className="muted">—</span> },
    {
      title: "订单确认时间", key: "confirmedAt", dataIndex: "confirmedAt", width: 130,
      sorter: (a, b) => a.confirmedAt.localeCompare(b.confirmedAt),
      render: (v: string) => <span className="nowrap">{fmtDate(v)}</span>,
    },
    { title: "业务员", key: "ownerName", dataIndex: "ownerName", width: 100, 默认: users.length > 1 },
  ];

  const 列表: 列<Row>[] = [
    {
      title: "订单号", key: "no", dataIndex: "no", width: 130, 常驻: true,
      render: (v: string, r) => <Link href={`/orders/${r.id}`} className="link-strong">{v}</Link>,
    },
    { title: "客户", key: "customerName", dataIndex: "customerName", width: 140, render: (v: string, r) => <Link href={`/customers/${r.customerId}`}>{v}</Link> },
    { title: "金额", key: "amount", dataIndex: "amount", width: 120, render: (v: number, r) => <span style={{ fontWeight: 600 }}>{金额(v, r.currency)}</span> },
    {
      title: "当前节点", key: "当前", width: 150,
      render: (_: unknown, r) => (r.当前 ? `${r.当前.idx}. ${r.当前.name}` : <span className="muted">已走完</span>),
    },
    {
      title: "节点", 列名: "12 个节点", key: "nodes", width: 12 * 22 + 16,
      render: (_: unknown, r) => (
        <span className="ord-cells">
          {r.nodes.map((n) => {
            const 色 = 节点灯(n);
            return (
              <Tooltip key={n.idx} title={`${n.idx}. ${n.name} · ${n.status}${n.dueAt ? ` · 截止 ${fmtDate(n.dueAt)}` : ""}`}>
                <Link href={`/orders/${r.id}?node=${n.idx}`} className={`ord-cell ord-${色}${r.当前?.idx === n.idx ? " ord-now" : ""}`} aria-label={`${n.name}：${n.status}`} />
              </Tooltip>
            );
          })}
        </span>
      ),
    },
    {
      title: "超期", key: "超期", dataIndex: "超期", width: 70,
      sorter: (a, b) => a.超期 - b.超期,
      render: (v: number) => (v > 0 ? <span className="ord-late">{v}</span> : <span className="muted">—</span>),
    },
    { title: "未收", key: "未收", dataIndex: "未收", width: 120, render: (v: number, r) => (v > 0 ? 金额(v, r.currency) : <span className="muted">收齐了</span>) },
    // 外贸客户要的那三列（二审：节点版一览原来没有），收在「列」里
    { title: "付款方式", key: "payment", dataIndex: "payment", width: 120, 默认: false, render: (v: string | null) => v ?? <span className="muted">—</span> },
    { title: "供应商", key: "supplier", dataIndex: "supplier", width: 140, 默认: false, render: (v: string | null) => v ?? <span className="muted">—</span> },
    { title: "订单确认时间", key: "confirmedAt", dataIndex: "confirmedAt", width: 120, 默认: false, render: (v: string) => <span className="nowrap">{fmtDate(v)}</span> },
    { title: "业务员", key: "ownerName", dataIndex: "ownerName", width: 100, 默认: users.length > 1 },
  ];

  return (
    <>
      <PageHead title="订单" subtitle={订单节点 ? "每行一单、每格一个节点：红 = 超期或卡住，黄 = 3 天内到期，绿 = 完成" : "客户确认的每一单。订单执行的进展记在跟进里，挂上这张订单"} />
      <DataList<Row>
        页="orders"
        列={订单节点 ? 列表 : 轻列}
        行={订单节点 ? 行 : [...行].sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt))}
        行链接={(r) => `/orders/${r.id}`}
        横向={订单节点 ? 1100 : undefined}
        空库={rows.length === 0 && !f.ownerId}
        空态={{
          title: "还没有订单",
          hint: 订单节点
            ? "商机赢单时点「生成订单」，客户、金额、报价都会带过来；也可以在客户页新建。订单按 12 个节点跟进：定金、下单给工厂、生产、订舱、装柜、单据尾款。"
            : "商机点「转为订单」，金额和币种会带过来；也可以在客户页的「订单」里新建。之后每次跟进时挂上订单号，订单执行的过程就都在这张订单里。",
          demo: false,
        }}
        筛选={
          users.length > 1 ? (
            <Space>
              <Select
                style={{ width: 140 }}
                placeholder="全部业务员"
                allowClear
                value={f.ownerId || undefined}
                onChange={(v) => apply({ ownerId: v ?? "" })}
                options={成员选项(users)}
              />
            </Space>
          ) : undefined
        }
        汇总={
          !订单节点 && rows.length > 0 ? (
            // 轻量一览一行合计（二审）：按币种分开，不换汇——和商机列表那颗药丸同一个说法
            <div className="list-sum">共 {rows.length} 单 · {合计文字(按币种合计(rows, (r) => r.amount, (r) => r.currency))}</div>
          ) : 订单节点 && rows.length > 0 ? (
            <div className="ord-stuck">
              {停.map((x) => (
                <span key={x.idx} className={x.超期 ? "ord-stuck-late" : undefined}>
                  {x.name} <b>{x.单}</b>
                  {x.超期 > 0 && <em>（超期 {x.超期}）</em>}
                </span>
              ))}
              {结了 > 0 && <span className="muted">已走完 {结了}</span>}
            </div>
          ) : undefined
        }
      />
    </>
  );
}
