"use client";

import { useEffect } from "react";
import { Modal, Form, Input, DatePicker, Select, App } from "antd";
import { FOLLOW_METHODS } from "@/lib/constants";
import { dayjs } from "@/lib/utils";
import { savePlan } from "./actions";

export default function PlanForm({
  open,
  onClose,
  onSaved,
  customerId,
  record,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  customerId: string;
  record: { id: string; subject: string; plannedAt: string; method: string } | null;
}) {
  const [form] = Form.useForm();
  const { message } = App.useApp();

  useEffect(() => {
    if (!open) return;
    if (record) {
      form.setFieldsValue({ ...record, plannedAt: dayjs(record.plannedAt) });
    } else {
      form.resetFields();
      form.setFieldsValue({
        method: "电话沟通",
        plannedAt: dayjs().add(2, "day").hour(9).minute(0),
      });
    }
  }, [open, record, form]);

  async function onOk() {
    const v = await form.validateFields();
    await savePlan({
      id: record?.id,
      customerId,
      subject: v.subject,
      plannedAt: v.plannedAt.toISOString(),
      method: v.method,
    });
    message.success("跟进计划已保存");
    onSaved();
  }

  return (
    <Modal
      open={open}
      title={record ? "编辑跟进计划" : "制定跟进计划"}
      onCancel={onClose}
      onOk={onOk}
      okText="保存"
      cancelText="取消"
      destroyOnHidden
    >
      <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
        <Form.Item name="subject" label="跟进主题" rules={[{ required: true, message: "请填写跟进主题" }]}>
          <Input placeholder="如：跟进预算审批进度" />
        </Form.Item>
        <Form.Item name="plannedAt" label="计划时间" rules={[{ required: true }]}>
          <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="method" label="跟进方式">
          <Select options={FOLLOW_METHODS.map((m) => ({ value: m, label: m }))} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
