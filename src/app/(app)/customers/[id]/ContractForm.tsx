"use client";

import { useState } from "react";
import { Modal, Form, InputNumber, DatePicker, Input, App } from "antd";
import { dayjs, money } from "@/lib/utils";
import { saveContract } from "../actions";

export type ContractRow = {
  id: string;
  amount: number;
  signedAt: string;
  remark: string | null;
};

export default function ContractForm({
  open,
  customerId,
  editing,
  onClose,
}: {
  open: boolean;
  customerId: string;
  editing: ContractRow | null;
  onClose: (saved: boolean) => void;
}) {
  if (!open) return null;
  return <Inner key={editing?.id ?? "new"} customerId={customerId} editing={editing} onClose={onClose} />;
}

function Inner({
  customerId,
  editing,
  onClose,
}: {
  customerId: string;
  editing: ContractRow | null;
  onClose: (saved: boolean) => void;
}) {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  async function submit(force: boolean) {
    const v = await form.validateFields();
    return saveContract({
      id: editing?.id,
      customerId,
      amount: v.amount,
      signedAt: v.signedAt.toDate(),
      remark: v.remark ?? null,
      force,
    });
  }

  async function onOk() {
    setSaving(true);
    try {
      const res = await submit(false);
      if (res.ok) {
        message.success(editing ? "已保存" : "签约已记录");
        onClose(true);
        return;
      }
      if ("error" in res) {
        message.error(res.error);
        return;
      }

      /**
       * 同学员 + 同金额 + 同一天，多半是两个人各录了一次同一笔。
       * 但续费和分期本来就可能同额同日，所以只确认、不硬拦。
       */
      const dup = res.duplicate;
      modal.confirm({
        title: "这笔签约可能已经录过了",
        content: (
          <>
            <div>
              该学员在 {dayjs(dup.signedAt).format("YYYY-MM-DD")} 已有一笔{" "}
              <b>{money(dup.amount)}</b> 的签约记录
              {dup.remark ? `（备注：${dup.remark}）` : ""}。
            </div>
            <div style={{ marginTop: 8 }}>
              如果这是续费或分期的另一笔，可以继续录入；如果是同一笔，请点取消，
              重复录入会让业绩合计翻倍。
            </div>
          </>
        ),
        okText: "确实是另一笔，继续录入",
        cancelText: "取消",
        async onOk() {
          const again = await submit(true);
          if (again.ok) {
            message.success(editing ? "已保存" : "签约已记录");
            onClose(true);
          } else if ("error" in again) {
            message.error(again.error);
          }
        },
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      title={editing ? "编辑签约记录" : "登记签约"}
      onCancel={() => onClose(false)}
      onOk={onOk}
      confirmLoading={saving}
      okText="保存"
      cancelText="取消"
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: 8 }}
        initialValues={
          editing
            ? { amount: editing.amount, signedAt: dayjs(editing.signedAt), remark: editing.remark }
            : { signedAt: dayjs() }
        }
      >
        <Form.Item label="签约金额（元）" name="amount" rules={[{ required: true, message: "请输入签约金额" }]}>
          <InputNumber<number>
            style={{ width: "100%" }}
            min={0}
            step={1000}
            placeholder="19800"
            formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
            parser={(v) => Number(v?.replace(/,/g, "") ?? 0)}
          />
        </Form.Item>
        <Form.Item label="签约时间" name="signedAt" rules={[{ required: true, message: "请选择签约时间" }]}>
          <DatePicker style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item label="备注" name="remark" extra="课程内容、付款方式、分期安排等">
          <Input.TextArea rows={3} placeholder="选填" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
