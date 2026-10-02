"use client";

import { useEffect, useState } from "react";
import { Modal, Form, Input, DatePicker, App } from "antd";
import { dayjs } from "@/lib/utils";
import { saveTask } from "./actions";

export default function TaskForm({
  open,
  onClose,
  onSaved,
  customerId,
  record = null,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  customerId: string;
  /** 给了就是编辑这一条（计划页「改」，2026-10-02 排查 3-4：原来待办建了就改不了） */
  record?: { id: string; title: string; dueAt: string | null } | null;
}) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  // 保存中：网慢时连点两下会建出两条一样的待办（2026-10-02 排查）
  const [存着, set存着] = useState(false);

  useEffect(() => {
    if (open) {
      form.resetFields();
      if (record) form.setFieldsValue({ title: record.title, dueAt: record.dueAt ? dayjs(record.dueAt) : null });
      else form.setFieldsValue({ dueAt: dayjs().add(1, "day").hour(9).minute(0) });
    }
  }, [open, form, record]);

  async function onOk() {
    const v = await form.validateFields();
    set存着(true);
    try {
      const r = await saveTask({
        id: record?.id,
        customerId,
        title: v.title,
        dueAt: v.dueAt ? v.dueAt.toISOString() : null,
      });
      if (!r.ok) return void message.error("没存上，请重试");
      message.success(record ? "已保存" : "任务已创建");
      void window.desktopReminders?.刷新();
      onSaved();
    } catch {
      message.error("没存上，请重试");
    } finally {
      set存着(false);
    }
  }

  return (
    <Modal
      open={open}
      title={record ? "改待办" : "新建待办任务"}
      onCancel={onClose}
      onOk={onOk}
      okText={record ? "保存" : "创建"}
      cancelText="取消"
      confirmLoading={存着}
      destroyOnHidden
    >
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
