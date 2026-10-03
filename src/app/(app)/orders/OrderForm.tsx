"use client";

import { useRouter } from "next/navigation";
import { App, AutoComplete, Col, Form, Input, InputNumber, Modal, Row, Select, Space } from "antd";
import CurrencySelect from "@/components/CurrencySelect";
import { 金额格式 } from "@/lib/money-input";
import { 聚焦首项 } from "@/lib/modal-focus";
import { useBusiness } from "@/lib/business-client";
import { 贸易条款们, 常用付款方式, 定金比例 } from "@/lib/order";
import { useRef } from "react";
import { createOrder, saveOrder } from "./actions";

export type 订单表头 = {
  id: string;
  no: string;
  amount: number;
  currency: string;
  incoterm: string | null;
  payment: string | null;
  depositDue: number;
  remark: string | null;
};

/**
 * 订单表头：订单号、金额 + 币种、贸易条款、付款方式、定金应收、备注。
 * 新建（给了 customerId、没给 editing）存完直接进那张订单；编辑存完留在原地刷新。
 * 定金实收、到账日、尾款不在这里：那是订单页「钱」那一块就地填的，填的时机和下单不是同一刻。
 */
export default function OrderForm({
  open,
  editing,
  customerId,
  onClose,
}: {
  open: boolean;
  editing?: 订单表头 | null;
  customerId?: string;
  onClose: (saved: boolean) => void;
}) {
  const router = useRouter();
  const { message } = App.useApp();
  const b = useBusiness();
  const [form] = Form.useForm();
  const 币种 = (Form.useWatch("currency", form) as string | undefined) ?? editing?.currency ?? b.currency;
  /** 定金应收人自己填过就不再替他算（同 lib/fill-untouched）；编辑一张已有定金的单也算填过 */
  const 手填定金 = useRef(!!editing?.depositDue);
  function 跟着算定金(_: unknown, all: { amount?: number; payment?: string }) {
    if (手填定金.current) return;
    const 比 = 定金比例(all.payment);
    if (比 !== null && all.amount) form.setFieldValue("depositDue", Math.round(all.amount * 比 * 100) / 100);
  }

  async function onOk() {
    // 校验没过：框里各格已经标红了，安静返回；不接住的话是一个没人处理的 Promise 拒绝
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const 表 = {
      no: editing ? v.no : v.no || undefined,
      amount: v.amount ?? 0,
      currency: v.currency,
      incoterm: v.incoterm ?? null,
      payment: v.payment ?? null,
      depositDue: v.depositDue ?? 0,
      remark: v.remark ?? null,
    };
    if (editing) {
      const r = await saveOrder(editing.id, 表);
      if (!r.ok) return message.error(r.error);
      message.success("已保存");
      onClose(true);
      router.refresh();
      return;
    }
    if (!customerId) return;
    const r = await createOrder({ ...表, customerId });
    if (!r.ok) return message.error(r.error);
    message.success("订单已建好");
    onClose(true);
    router.push(`/orders/${r.id}`);
  }

  return (
    <Modal
      afterOpenChange={聚焦首项}
      open={open}
      title={editing ? "编辑订单" : "新建订单"}
      onCancel={() => onClose(false)}
      onOk={onOk}
      okText="保存"
      cancelText="取消"
      width={600}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: 8 }}
        onValuesChange={(changed, all) => {
          if ("depositDue" in changed) 手填定金.current = true;
          else if ("payment" in changed || "amount" in changed) 跟着算定金(changed, all);
        }}
        initialValues={
          editing
            ? { ...editing, incoterm: editing.incoterm ?? undefined, payment: editing.payment ?? undefined }
            : { currency: b.currency, incoterm: "FOB", payment: "T/T 30/70" }
        }
      >
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              name="no"
              label="订单号 / PI 号"
              rules={editing ? [{ required: true, whitespace: true, message: "订单号不能空着" }] : []}
              extra={editing ? undefined : "不填就按日期编一个，比如 20261003-1"}
            >
              <Input maxLength={40} placeholder={editing ? undefined : "选填"} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="订单金额" required>
              <Space.Compact style={{ width: "100%" }}>
                <Form.Item name="currency" noStyle>
                  <CurrencySelect />
                </Form.Item>
                <Form.Item name="amount" noStyle rules={[{ required: true, message: "请填订单金额" }]}>
                  <InputNumber<number> min={0} style={{ width: "100%" }} formatter={金额格式} aria-label="订单金额" />
                </Form.Item>
              </Space.Compact>
            </Form.Item>
          </Col>
          <Col span={12}>
            {/* 改条款不会重排单据清单：清单可能已经勾过了，换一遍会把人的勾冲掉。新建时按条款给一组默认的 */}
            <Form.Item name="incoterm" label="贸易条款" extra={editing ? undefined : "按它列默认要收的单据（EXW 不订舱、不报关）"}>
              <Select allowClear options={贸易条款们.map((x) => ({ value: x, label: x }))} placeholder="FOB / CIF / EXW…" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="payment" label="付款方式">
              <AutoComplete options={常用付款方式.map((x) => ({ value: x }))} placeholder="如 T/T 30/70" filterOption={(i, o) => String(o?.value ?? "").toLowerCase().includes(i.toLowerCase())} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="depositDue"
              label="定金应收"
              dependencies={["amount"]}
              rules={[
                ({ getFieldValue }) => ({
                  validator: (_, v) => ((v ?? 0) > (getFieldValue("amount") ?? 0) ? Promise.reject(new Error("定金比订单金额还多")) : Promise.resolve()),
                }),
              ]}
              extra="选了「T/T 30/70」这类会按比例先算好；没有定金留空"
            >
              <InputNumber<number> min={0} style={{ width: "100%" }} formatter={金额格式} prefix={币种} />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="remark" label="备注">
              <Input.TextArea rows={2} placeholder="包装、唛头、目的港…" maxLength={2000} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
