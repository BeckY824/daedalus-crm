"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Card, Descriptions, Input, Space } from "antd";
import { EditOutlined } from "@ant-design/icons";
import { PageHead } from "@/components/ui";
import { fmtDate, fmtDateTime } from "@/lib/utils";
import { 金额 } from "@/lib/currency";
import type { 订单详情数据 } from "@/lib/order-db";
import ContractForm from "../../customers/[id]/ContractForm";
import { addOrderNote } from "../actions";
import { 供应商页, 报价明细 } from "@/lib/features";
import { 小计, 报价合计 } from "@/lib/quote";

/**
 * 一张订单，轻量版（2026-10-05 外贸客户建议；节点关着时用它，见 lib/features.ts 订单节点）。
 *
 * 客户要的就两样：订单上的几项信息（订单号、客户、金额、付款方式、供应商、确认时间），
 * 和「对订单执行做跟进的记录」——所以下面是挂在这张订单上的跟进，顶上一个框直接记一笔。
 * 改订单走客户页同一个订单框；删订单在客户页（删最后一笔要问跟进状态退到哪，那个问话只在那里）。
 */
export default function OrderLite({ o }: { o: 订单详情数据 }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [改, set改] = useState(false);
  const [话, set话] = useState("");
  const [存着, set存着] = useState(false);
  const c = o.contract;
  const 钱 = c ? 金额(c.amount, c.currency) : 金额(o.amount, o.currency);
  const 确认 = c?.signedAt ?? o.createdAt;

  async function 记() {
    if (!话.trim() || 存着) return;
    set存着(true);
    try {
      const r = await addOrderNote(o.id, 话);
      if (!r.ok) return void message.error(r.error);
      set话("");
      message.success("记下了，也在客户的时间线里");
      router.refresh();
    } finally {
      set存着(false);
    }
  }

  return (
    <>
      <PageHead
        title={`订单 ${o.no}`}
        subtitle={[o.customer.name, 钱, `确认于 ${fmtDate(确认)}`].join(" · ")}
        extra={
          <Space>
            <Link href={`/customers/${o.customer.id}`}>{o.customer.name} 的记录 ›</Link>
            {c && <Button icon={<EditOutlined />} onClick={() => set改(true)}>编辑</Button>}
          </Space>
        }
      />

      <Card>
        <Descriptions column={{ xs: 1, sm: 2, lg: 3 }} size="small">
          <Descriptions.Item label="客户"><Link href={`/customers/${o.customer.id}`}>{o.customer.name}</Link></Descriptions.Item>
          <Descriptions.Item label="订单号">{o.no}</Descriptions.Item>
          <Descriptions.Item label="金额"><b>{钱}</b></Descriptions.Item>
          <Descriptions.Item label="付款方式">{o.payment ?? <span className="muted">—</span>}</Descriptions.Item>
          <Descriptions.Item label="供应商">
            {o.采购?.supplierName
              ? 供应商页 && o.采购.supplierId ? <Link href={`/suppliers/${o.采购.supplierId}`}>{o.采购.supplierName}</Link> : o.采购.supplierName
              : <span className="muted">—</span>}
          </Descriptions.Item>
          <Descriptions.Item label="订单确认时间">{fmtDate(确认)}</Descriptions.Item>
          <Descriptions.Item label="业务员">{o.ownerName}</Descriptions.Item>
          {o.opportunity && (
            <Descriptions.Item label="来自商机">
              <Link href={`/opportunities?keyword=${encodeURIComponent(o.opportunity.name)}`}>{o.opportunity.name}</Link>
            </Descriptions.Item>
          )}
          {(c?.remark ?? o.remark) && <Descriptions.Item label="备注" span="filled">{c?.remark ?? o.remark}</Descriptions.Item>}
        </Descriptions>
      </Card>

      {/* 报价明细开着时（lib/features.ts）：来源商机当前那一版报价，和节点版订单页同一块（二审） */}
      {报价明细 && o.报价 && (
        <Card style={{ marginTop: 16 }} title={<span className="section-title">报价明细</span>} extra={<span className="muted">{fmtDate(o.报价.quotedAt)} 报的价，来自商机</span>}>
          <table className="ord-quote">
            <thead><tr><th>产品</th><th>规格</th><th className="r">数量</th><th className="r">单价</th><th className="r">小计</th></tr></thead>
            <tbody>
              {o.报价.行.map((r, i) => (
                <tr key={i}><td>{r.product}</td><td>{r.spec ?? ""}</td><td className="r">{r.qty}{r.unit ? ` ${r.unit}` : ""}</td><td className="r">{金额(r.unitPrice, o.报价!.currency)}</td><td className="r">{金额(小计(r), o.报价!.currency)}</td></tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={4}>合计</td><td className="r"><b>{金额(报价合计(o.报价.行), o.报价.currency)}</b></td></tr></tfoot>
          </table>
        </Card>
      )}

      <Card style={{ marginTop: 16 }} title={<span className="section-title">订单跟进 {o.notes.length > 0 && o.notes.length}</span>}>
        <div className="ord-note-box">
          <Input.TextArea
            value={话}
            onChange={(e) => set话(e.target.value)}
            autoSize={{ minRows: 2, maxRows: 6 }}
            maxLength={5000}
            placeholder="记一笔：工厂说的交期、验货结果、订舱、客户付了多少……"
            aria-label="在这张订单上记一笔"
          />
          <Button type="primary" loading={存着} disabled={!话.trim()} onClick={() => void 记()}>记下</Button>
        </div>
        {o.notes.length === 0 ? (
          <div className="muted" style={{ marginTop: 12 }}>
            还没有。在这里记，或者在客户页记跟进时「关联商机 / 订单」选上这张订单。
          </div>
        ) : (
          <ul className="ord-notes">
            {o.notes.map((n) => (
              <li key={n.id}>
                <div className="ord-note-h">
                  <span>{n.who}</span>
                  <span className="muted" title={fmtDateTime(n.occurredAt)}>{fmtDateTime(n.occurredAt)}</span>
                </div>
                <div className="ord-note-c">{n.content}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {c && (
        <ContractForm
          open={改}
          customerId={o.customer.id}
          editing={{ id: c.id, amount: c.amount, currency: c.currency, signedAt: c.signedAt, remark: c.remark, order: { id: o.id, no: o.no, payment: o.payment, supplier: o.采购?.supplierName ?? null } }}
          onClose={(saved) => {
            set改(false);
            if (saved) router.refresh();
          }}
        />
      )}
    </>
  );
}
