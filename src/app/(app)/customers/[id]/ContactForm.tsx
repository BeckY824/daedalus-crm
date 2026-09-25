"use client";

import { useEffect } from "react";
import { Modal, Form, Input, Switch, Row, Col, App, AutoComplete, Select } from "antd";
import { saveContact } from "./actions";
import type { ContactRow } from "./types";
import { useBusiness } from "@/lib/business-client";

/**
 * 与学员的关系。教培场景里联系人绝大多数是家长，
 * 但也可能是姑姑、哥哥这类——取值有限却不封闭，
 * 所以用 AutoComplete 给常用项、同时允许自己填，不用 Select 硬约束。
 *
 * 数据库列名仍是 position（原本是 To B 的「职务」），
 * 改列要动迁移，而迁移纪律是只增不改；列名是内部的，界面上叫什么才是用户看到的。
 */
const 关系选项 = ["母亲", "父亲", "学生本人", "其他亲属"].map((v) => ({ value: v }));

/**
 * 联系人表单。两处共用：学员记录页（已经知道是谁，不问）和联系人列表页
 * （跨学员的入口，必须先选人）。
 *
 * 不给列表页另写一份：两份表单迟早会长出不同的字段和不同的校验，
 * 而「这个人是谁的联系人」恰恰是唯一的差别——一个 Select 的事。
 */
export default function ContactForm({
  open,
  onClose,
  onSaved,
  customerId,
  学员们,
  record,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** 记录页上给定；列表页上不给，改由表单里选 */
  customerId?: string;
  /** 只有不给 customerId 时才用得上：可选的学员 */
  学员们?: { id: string; name: string }[];
  record: ContactRow | null;
}) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const b = useBusiness();

  useEffect(() => {
    if (!open) return;
    if (record) form.setFieldsValue(record);
    else {
      form.resetFields();
      form.setFieldsValue({ isPrimary: false });
    }
  }, [open, record, form]);

  async function onOk() {
    const v = await form.validateFields();
    // 记录页给的 customerId 说了算；列表页上它在表单里
    const 归属 = customerId ?? (v.customerId as string);
    await saveContact({ id: record?.id, ...v, customerId: 归属 });
    message.success(record ? "已保存" : "联系人已添加");
    onSaved();
  }

  return (
    <Modal
      open={open}
      title={record ? `编辑联系人 · ${record.name}` : "添加联系人"}
      onCancel={onClose}
      onOk={onOk}
      okText="保存"
      cancelText="取消"
      width={560}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
        <Row gutter={16}>
          {/* 从联系人列表进来时先选人：联系人挂在某一位学员下面，没有归属的联系人没有意义 */}
          {!customerId && (
            <Col span={24}>
              <Form.Item name="customerId" label={`所属${b.customer}`} rules={[{ required: true, message: `请选择所属${b.customer}` }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder={`搜索并选择一位${b.customer}`}
                  options={(学员们 ?? []).map((c) => ({ value: c.id, label: c.name }))}
                />
              </Form.Item>
            </Col>
          )}
          <Col span={12}>
            <Form.Item name="name" label="姓名" rules={[{ required: true, message: "请填写姓名" }]}>
              <Input placeholder="张经理" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="position" label={`与${b.customer}关系`}>
              <AutoComplete options={关系选项} placeholder="母亲" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="phone" label="手机号">
              <Input placeholder="13800002211" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="email" label="邮箱">
              <Input placeholder="name@company.com" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="wechat" label="微信">
              <Input placeholder="微信号" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="isPrimary" label="关键联系人" valuePropName="checked">
              <Switch checkedChildren="是" unCheckedChildren="否" />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="remark" label="备注">
              <Input.TextArea rows={2} placeholder="决策角色、沟通偏好、注意事项…" />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
