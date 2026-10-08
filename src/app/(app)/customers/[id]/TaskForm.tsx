"use client";

import DatePicker from "@/components/BusinessDatePicker";

import { requiredText } from "@/lib/form-validation";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Form, Input, App, Checkbox, Typography } from "antd";
import { isCalendarDate } from "@/lib/schedule-date";
import { dayjs } from "@/lib/utils";
import { saveTask } from "./actions";
import { 聚焦首项 } from "@/lib/modal-focus";

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
  /** updatedAt：编辑时的版本号（J-105），保存时交回去当闸门 */
  record?: { id: string; title: string; dueAt: string | null; dueHasTime?: boolean | null; updatedAt?: string } | null;
}) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const router = useRouter();
  const hasTime = Form.useWatch("hasTime", form) ?? true;
  // 保存中：网慢时连点两下会建出两条一样的待办（2026-10-02 排查）
  const [存着, set存着] = useState(false);

  useEffect(() => {
    if (open) {
      form.resetFields();
      if (record) form.setFieldsValue({ title: record.title, dueAt: record.dueAt ? dayjs(record.dueAt) : null, hasTime: !record.dueAt || !isCalendarDate(record.dueAt) });
      else form.setFieldsValue({ hasTime: true, dueAt: dayjs().add(1, "day").hour(9).minute(0) });
      form.setFields([{ name: "hasTime", touched: false }, { name: "dueAt", touched: false }]);
    }
  }, [open, form, record]);

  async function onOk() {
    /*
      和另外三个弹框一样先拦再校验（2026-10-04 J-107）：原来 set存着 在 validateFields 之后，
      校验那一下的空当里第二下点击还能进来，只靠按钮转圈挡着
    */
    if (存着) return;
    set存着(true);
    // 校验没过：红字在框里，不另报「没存上」
    const v = await form.validateFields().catch(() => null);
    if (!v) return void set存着(false);
    try {
      const r = await saveTask({
        id: record?.id,
        版本: record?.updatedAt,
        customerId,
        title: v.title,
        dueAt: v.dueAt ? v.hasTime ? v.dueAt.toISOString() : v.dueAt.format("YYYY-MM-DD") : null,
        dueHasTime: !record || record.dueHasTime != null || form.isFieldTouched("hasTime") || form.isFieldTouched("dueAt") ? Boolean(v.hasTime) : undefined,
      });
      if (!r.ok) {
        // 服务端那句话照说（打开之后这条又变过了 / 已经删了，J-105），原来一律「没存上，请重试」，人只会再点一次、再被拦
        message.error("error" in r && r.error ? r.error : "没存上，请重试");
        if (record) router.refresh();
        return;
      }
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
      afterOpenChange={聚焦首项}
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
        <Form.Item name="title" label="任务内容" rules={[requiredText("请填写任务内容")]}>
          <Input placeholder="如：跟进预算审批进度" />
        </Form.Item>
        <Form.Item name="hasTime" valuePropName="checked"><Checkbox>指定钟点并到点提醒</Checkbox></Form.Item>
        {record?.dueAt && record.dueHasTime == null && !isCalendarDate(record.dueAt) && <Typography.Paragraph type="secondary">旧记录未保存是否选了钟点；只改内容会保留原提醒方式，请核对后重新选择日期或钟点。</Typography.Paragraph>}
        <Form.Item name="dueAt" label="截止时间">
          <DatePicker showTime={hasTime} format={hasTime ? "YYYY-MM-DD HH:mm" : "YYYY-MM-DD"} style={{ width: "100%" }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
