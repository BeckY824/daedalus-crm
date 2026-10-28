"use client";

import { Select, Space, Switch, Tooltip } from "antd";
import { RowLink, PageHead, CustomerLink } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
import { useUrlFilters } from "@/lib/url-filters";
import { 成员选项, fmtDate, type 可选成员 } from "@/lib/utils";
import { 金额, 合计文字 } from "@/lib/currency";
import { 节点灯 } from "@/lib/order";
import type { 订单行 } from "@/lib/order-db";
import { 订单节点 } from "@/lib/features";
import { 订单比较, 一览顺序, 算汇总, type 订单分页 } from "@/lib/orders-paging";

/** 行名（登记给 AI 面板的那个）用客户名：问「Acme 那单」时 list_orders 按 customerName 查得到 */
type Row = 订单行;

/**
 * 订单一览：行是单，列是 12 个节点，格子按颜色说话——红 = 超期或卡住，黄 = 3 天内到期，绿 = 完成，灰 = 不适用。
 * 顶上一行按节点数「停在这一步几单、其中超期几单」：老板一眼看出卡在哪（外贸CRM模版.md 4.1 / 4.2）。
 * 点格子进订单、直接打开那一步。
 *
 * 给了 分页（企业版单子多时，lib/orders-paging.ts）：rows 只是服务端排好的这一页，合计用服务端在全部上算的那份，
 * 翻页、排序走网址。没给：rows 是全部，照原来在浏览器里排、分页、算合计。
 */
export default function OrdersView({ rows, users, filters, 分页 }: { rows: 订单行[]; users: 可选成员[]; filters: { ownerId: string; 我: string }; 分页?: 订单分页 }) {
  const { f, apply, 翻页, pending } = useUrlFilters("/orders", { ...filters, sort: 分页?.sort ?? "" }, 分页?.每页);
  const 行: Row[] = rows;

  const 汇总 = 分页?.汇总 ?? 算汇总(rows);
  const { 停, 结了 } = 汇总;
  /** 能排序的列：不分页时照原来在浏览器里排；分页时交给服务端，表头只显示现在按什么排 */
  const 排 = (k: keyof typeof 订单比较): Pick<列<Row>, "sorter" | "sortOrder"> =>
    分页 ? { sorter: true, sortOrder: 分页.sort === `${k}-asc` ? "ascend" : 分页.sort === `${k}-desc` ? "descend" : null } : { sorter: 订单比较[k] };

  /*
    轻量的订单一览（2026-10-05 外贸客户建议，节点关着时）：客户要的列就是这几样——
    客户名称、订单号、付款方式、供应商名称、订单确认时间，再加金额和业务员。新确认的在前
  */
  const 轻列: 列<Row>[] = [
    {
      title: "订单号", key: "no", dataIndex: "no", width: 150, 常驻: true,
      render: (v: string, r) => <RowLink href={`/orders/${r.id}`} className="link-strong">{v}</RowLink>,
    },
    { title: "客户", key: "customerName", dataIndex: "customerName", width: 180, render: (v: string, r) => <CustomerLink id={r.customerId} name={v} company={r.customerCompany} logo={false} /> },
    { title: "金额", key: "amount", dataIndex: "amount", width: 130, render: (v: number, r) => <span style={{ fontWeight: 600 }}>{金额(v, r.currency)}</span> },
    { title: "付款方式", key: "payment", dataIndex: "payment", width: 130, render: (v: string | null) => v ?? <span className="muted">—</span> },
    { title: "供应商", key: "supplier", dataIndex: "supplier", width: 160, render: (v: string | null) => v ?? <span className="muted">—</span> },
    {
      title: "订单确认时间", key: "confirmedAt", dataIndex: "confirmedAt", width: 130,
      ...排("confirmed"),
      render: (v: string) => <span className="nowrap">{fmtDate(v)}</span>,
    },
    { title: "业务员", key: "ownerName", dataIndex: "ownerName", width: 100, 默认: users.length > 1 },
  ];

  const 列表: 列<Row>[] = [
    {
      title: "订单号", key: "no", dataIndex: "no", width: 130, 常驻: true,
      render: (v: string, r) => <RowLink href={`/orders/${r.id}`} className="link-strong">{v}</RowLink>,
    },
    { title: "客户", key: "customerName", dataIndex: "customerName", width: 140, render: (v: string, r) => <CustomerLink id={r.customerId} name={v} company={r.customerCompany} logo={false} /> },
    { title: "金额", key: "amount", dataIndex: "amount", width: 120, render: (v: number, r) => <span style={{ fontWeight: 600 }}>{金额(v, r.currency)}</span> },
    {
      title: "当前节点", key: "当前", width: 150,
      // 最近一轮验货不过：卡在返工（0.46.30 D-45），当前节点后面挂一个红签
      render: (_: unknown, r) => (
        <span className="clamp-1">
          {r.当前 ? `${r.当前.idx}. ${r.当前.name}` : <span className="muted">已走完</span>}
          {r.返工 && <span className="ord-chip bad ord-rework">返工</span>}
        </span>
      ),
    },
    {
      title: "节点", 列名: "12 个节点", key: "nodes", width: 12 * 22 + 16,
      render: (_: unknown, r) => (
        <span className="ord-cells">
          {r.nodes.map((n) => {
            const 色 = 节点灯(n);
            return (
              <Tooltip key={n.idx} title={`${n.idx}. ${n.name} · ${n.status}${n.dueAt ? ` · 截止 ${fmtDate(n.dueAt)}` : ""}`}>
                <RowLink href={`/orders/${r.id}?node=${n.idx}`} className={`ord-cell ord-${色}${r.当前?.idx === n.idx ? " ord-now" : ""}`} aria-label={`${n.name}：${n.status}`} />
              </Tooltip>
            );
          })}
        </span>
      ),
    },
    {
      title: "超期", key: "超期", dataIndex: "超期", width: 70,
      ...排("late"),
      render: (v: number) => (v > 0 ? <span className="ord-late">{v}</span> : <span className="muted">—</span>),
    },
    {
      // 到港（0.46.30 D-46）：和节点同一套灯；到港临近或过了、钱没收齐挂「催尾款」
      title: "到港", key: "eta", width: 120,
      render: (_: unknown, r) =>
        r.ata ? <span className="ord-eta ord-eta-绿">已到</span>
        : r.eta ? (
          <span className="ord-eta">
            <span className={`ord-eta-${r.到港灯}`}>{fmtDate(r.eta)}</span>
            {r.催尾款 && <span className="ord-chip bad ord-rework">催尾款</span>}
          </span>
        ) : <span className="muted">—</span>,
    },
    { title: "样品", key: "样品", dataIndex: "样品", width: 80, 默认: false, render: (v: string) => (v === "未寄" ? <span className="muted">—</span> : v) },
    { title: <Tooltip title="订单金额减去定金实收和尾款实收，最低为0；按订单币种计算">未收</Tooltip>, 列名: "未收", key: "未收", dataIndex: "未收", width: 120, render: (v: number, r) => (v > 0 ? 金额(v, r.currency) : <span className="muted">收齐了</span>) },
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
        行={分页 ? 行 : 一览顺序(行, 订单节点)}
        行链接={(r) => `/orders/${r.id}`}
        横向={订单节点 ? 1100 : undefined}
        空库={汇总.单 === 0 && !f.ownerId && !f.我}
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
              {订单节点 && (
                <label className="ord-mine-tog">
                  <Switch size="small" checked={!!f.我} onChange={(v) => apply({ 我: v ? "1" : "" })} aria-label="只看我该做的" />
                  我该做的
                </label>
              )}
            </Space>
          ) : undefined
        }
        汇总={
          汇总.单 > 0 ? (
            <>
            <div className="list-sum">全部筛选结果 · 共 {汇总.单} 单 · {合计文字(汇总.金额)}{订单节点 && <> · 未收 {合计文字(汇总.未收)}</>}</div>
            {订单节点 && (
            <div className="ord-stuck">
              {停.map((x) => (
                <span key={x.idx} className={x.超期 ? "ord-stuck-late" : undefined}>
                  {x.name} <b>{x.单}</b>
                  {x.超期 > 0 && <em>（超期 {x.超期}）</em>}
                </span>
              ))}
              {结了 > 0 && <span className="muted">已走完 {结了}</span>}
            </div>
            )}
            </>
          ) : undefined
        }
        {...(分页 ? {
          分页: { 当前页: 分页.页, 每页: 分页.每页, 总数: 分页.总数, 翻页 },
          排序: (key: string, order: "ascend" | "descend" | null) => {
            const k = key === "confirmedAt" ? "confirmed" : key === "超期" ? "late" : "";
            if (k) apply({ sort: order === "ascend" ? `${k}-asc` : order === "descend" ? `${k}-desc` : "" });
          },
          加载中: pending,
        } : {})}
      />
    </>
  );
}
