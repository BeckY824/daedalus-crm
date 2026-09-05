"use client";

import { useEffect } from "react";
import { Modal, Form, Input, DatePicker, App } from "antd";
import { dayjs } from "@/lib/utils";
import { saveTask } from "./actions";

export default function TaskForm({
  open,
  onClose,
  onSaved,
  customerId,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  customerId: string;
}) {
  const [form] = Form.useForm();
  const { message } = App.useApp();

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({ dueAt: dayjs().add(1, "day").hour(9).minute(0) });
    }
  }, [open, form]);

  async function onOk() {
    const v = await form.validateFields();
    await saveTask({
      customerId,
      title: v.title,
      dueAt: v.dueAt ? v.dueAt.toISOString() : null,
    });
    message.success("任务已创建");
    onSaved();
  }

  return (
    <Modal open={open} title="新建待办任务" onCancel={onClose} onOk={onOk} okText="创建" cancelText="取消" destroyOnHidden>
      <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
        <Form.Item name="title" label="任务内容" rules={[{ required: true, message: "请填写任务内容" }]}>
          <Input placeholder="如：跟进预算审批进度" />
        </Form.Item>
        <Form.Item name="dueAt" label="截止时间">
          <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
