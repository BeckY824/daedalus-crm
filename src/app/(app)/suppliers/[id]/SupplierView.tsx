"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Card, Col, Descriptions, Row, Space, Table, Tag } from "antd";
import { DeleteOutlined, EditOutlined } from "@ant-design/icons";
import { PageHead } from "@/components/ui";
import { fmtDate } from "@/lib/utils";
import { 金额 } from "@/lib/currency";
import { 过期了 } from "@/lib/supplier";
import type { 供应商详情数据 } from "@/lib/supplier-db";
import SupplierForm from "../SupplierForm";
import { deleteSupplier, 删供应商前清点 } from "../actions";

const 结论色: Record<string, string> = { 选用: "success", 备选: "processing", 淘汰: "default", 待定: "warning" };

/**
 * 一家供应商：档案（「出过的问题」放在最显眼处）、历次比价（问过什么、报多少、选没选、为什么）、从它这儿采过的订单。
 * 下次同类询盘先翻这一页，不用再问一遍价。
 */
export default function SupplierView({ s }: { s: 供应商详情数据 }) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [编辑, set编辑] = useState(false);

  async function 删除() {
    const 数 = await 删供应商前清点(s.id);
    modal.confirm({
      title: `删除供应商「${s.name}」？`,
      content: [
        数.比价 ? `它的 ${数.比价} 条比价记录会一起删掉。` : "",
        数.订单 ? `${数.订单} 张订单的采购上写着它，删了以后那几张订单的供应商变成空的（采购额还在）。` : "",
        "不能撤销。",
      ].filter(Boolean).join(""),
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        const r = await deleteSupplier(s.id);
        if (!r.ok) return message.error(r.error);
        message.success("供应商已删除");
        router.push("/suppliers");
      },
    });
  }

  return (
    <>
      <PageHead
        title={s.name}
        subtitle={[s.category, s.region, s.rating ? `评级 ${s.rating}` : null].filter(Boolean).join(" · ") || "供应商"}
        extra={
          <Space>
            <Button icon={<EditOutlined />} onClick={() => set编辑(true)}>编辑</Button>
            <Button danger icon={<DeleteOutlined />} onClick={() => void 删除()} aria-label="删除供应商" />
          </Space>
        }
      />
      {s.issues && (
        <div className="sup-issues" role="note">
          <b>出过的问题</b>
          <span>{s.issues}</span>
        </div>
      )}
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={8}>
          <Card title={<span className="section-title">档案</span>}>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="联系人">{s.contact ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="电话">{s.phone ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="微信">{s.wechat ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="开票">{s.invoice ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="付款方式">{s.payment ?? "—"}</Descriptions.Item>
              {s.remark && <Descriptions.Item label="备注">{s.remark}</Descriptions.Item>}
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} xl={16}>
          <Card title={<span className="section-title">历次比价 {s.quotes.length || ""}</span>}>
            <Table
              rowKey="id"
              size="small"
              pagination={s.quotes.length > 20 ? { pageSize: 20 } : false}
              dataSource={s.quotes}
              locale={{ emptyText: "还没比过价。在商机的「供应商比价」里加一行就会出现在这儿" }}
              rowClassName={(r) => (过期了(r.validUntil) ? "cmp-old" : "")}
              columns={[
                { title: "日期", dataIndex: "quotedAt", key: "d", width: 112, render: (v: string) => fmtDate(v) },
                { title: "产品", dataIndex: "product", key: "p" },
                { title: "出厂价", key: "price", width: 150, render: (_, r) => <span className="cmp-price">{金额(r.unitPrice, r.currency)} <span className="muted">{r.withInvoice ? "含票" : "不含票"}</span></span> },
                { title: "询盘", key: "o", render: (_, r) => <Link href={`/opportunities?keyword=${encodeURIComponent(r.商机)}`}>{r.客户} · {r.商机}</Link> },
                { title: "结论", key: "v", render: (_, r) => <span><Tag color={结论色[r.verdict]} style={{ margin: 0 }}>{r.verdict}</Tag>{r.reason && <span className="cmp-reason"> {r.reason}</span>}</span> },
              ]}
            />
          </Card>
          <Card title={<span className="section-title">采过的订单 {s.purchases.length || ""}</span>} style={{ marginTop: 16 }}>
            {s.purchases.length === 0 ? (
              <div className="muted">还没有订单的采购写着它</div>
            ) : (
              <Table
                rowKey="orderId"
                size="small"
                pagination={false}
                dataSource={s.purchases}
                columns={[
                  { title: "订单", key: "no", render: (_, r) => <Link href={`/orders/${r.orderId}`} className="link-strong">{r.no}</Link> },
                  { title: "客户", dataIndex: "客户", key: "c" },
                  { title: "销售额", key: "a", render: (_, r) => 金额(r.amount, r.currency) },
                  { title: "采购额", key: "cost", render: (_, r) => (r.cost ? 金额(r.cost, r.costCurrency) : <span className="muted">没填</span>) },
                  { title: "下单", dataIndex: "createdAt", key: "d", render: (v: string) => fmtDate(v) },
                ]}
              />
            )}
          </Card>
        </Col>
      </Row>
      <SupplierForm
        open={编辑}
        editing={{ id: s.id, name: s.name, category: s.category, region: s.region, contact: s.contact, phone: s.phone, wechat: s.wechat, invoice: s.invoice, payment: s.payment, rating: s.rating ?? "", issues: s.issues, remark: s.remark }}
        onClose={() => set编辑(false)}
      />
    </>
  );
}
