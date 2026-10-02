"use client";

import OptionInput from "@/components/OptionInput";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Form, Input, DatePicker, App, Button } from "antd";
import { FOLLOW_METHODS } from "@/lib/constants";
import { dayjs } from "@/lib/utils";
import { savePlan } from "./actions";
import CustomerPick, { type 客户近况 } from "./CustomerPick";

/**
 * 跟进计划表单。两处用：记录页（给了 customerId，已经知道是谁）和计划页页头的「新建计划」
 * （不给，第一格挑人，见 CustomerPick）。只有一份，和 ContactForm 同一个道理：
 * 两份表单迟早长出不同的字段和校验，而差别只有「是谁的」这一格。
 */
export default function PlanForm({
  open,
  onClose,
  onSaved,
  customerId,
  预选客户,
  record,
  默认天数 = 2,
}: {
  open: boolean;
  onClose: () => void;
  /** 新建时带回新计划的 id：计划页要把那一行点亮 */
  onSaved: (id?: string) => void;
  /** 记录页上给定；计划页上不给，改由表单第一格挑 */
  customerId?: string;
  /** 不给 customerId 时预填的那一位（从某位客户带过来的） */
  预选客户?: { id: string; name: string } | null;
  record: { id: string; subject: string; plannedAt: string; method: string } | null;
  /** 新建时计划时间默认几天后的 9 点。完成一次之后「排下一次」默认一周后（审查 M10） */
  默认天数?: number;
}) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const router = useRouter();
  const 挑人 = !customerId;
  /** 挑中那位的近况（上次跟进、欠着的计划）。关框时清掉，下次打开不带着上一位 */
  const [近况, set近况] = useState<客户近况 | null>(null);

  useEffect(() => {
    if (!open) return;
    if (record) {
      form.setFieldsValue({ ...record, plannedAt: dayjs(record.plannedAt) });
    } else {
      form.resetFields();
      form.setFieldsValue({
        method: "电话沟通",
        plannedAt: dayjs().add(默认天数, "day").hour(9).minute(0),
      });
    }
  }, [open, record, form, 默认天数]);

  function 关() {
    set近况(null);
    onClose();
  }

  /*
    保存中：网慢时连点两下会建出两条一样的记录（跟进带的 AI 待办和计划也各建两份，2026-10-02 排查）。
    校验没过（validateFields 抛出）也会走 finally 放开
  */
  const [存着, set存着] = useState(false);
  async function 保存() {
    if (存着) return;
    set存着(true);
    try {
      await onOk();
    } finally {
      set存着(false);
    }
  }

  async function onOk() {
    const v = await form.validateFields();
    const 谁 = customerId ?? (v.customerId as string);
    const res = await savePlan({
      id: record?.id,
      customerId: 谁,
      subject: v.subject,
      plannedAt: v.plannedAt.toISOString(),
      method: v.method,
    });
    set近况(null);
    onSaved(res.id);
    if (!挑人 || !近况) return void message.success("跟进计划已保存");
    // 列表页上建的：人留在原地，提示里给一条去他记录页的路
    const key = `plan-new-${res.id}`;
    const 名 = 近况.name;
    message.success({
      key,
      duration: 6,
      content: (
        <span>
          已给{名}排上「{v.subject.trim()}」
          <Button type="link" size="small" onClick={() => { message.destroy(key); router.push(`/customers/${谁}`); }}>
            去{名}的记录页
          </Button>
        </span>
      ),
    });
  }

  return (
    <Modal
      open={open}
      title={record ? "编辑跟进计划" : 挑人 ? "新建跟进计划" : "制定跟进计划"}
      onCancel={关}
      onOk={保存}
      confirmLoading={存着}
      okText="保存"
      cancelText="取消"
      destroyOnHidden
    >
      <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
        {挑人 && <CustomerPick 预选={预选客户} 近况={近况} on近况={set近况} 给计划 />}
        <Form.Item name="subject" label="跟进主题" rules={[{ required: true, message: "请填写跟进主题" }]}>
          <Input placeholder="如：跟进预算审批进度" />
        </Form.Item>
        <Form.Item name="plannedAt" label="计划时间" rules={[{ required: true }]}>
          <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="method" label="跟进方式">
          <OptionInput options={FOLLOW_METHODS} allowClear={false} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
