"use client";

import { useEffect } from "react";
import { Modal, Form, Input, Switch, Row, Col, App, AutoComplete } from "antd";
import { saveContact } from "./actions";
import type { ContactRow } from "./CustomerDetailView";
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

export default function ContactForm({
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
    await saveContact({ id: record?.id, customerId, ...v });
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
          <Col span={12}>
            <Form.Item name="name" label="姓名" rules={[{ required: true, message: "请填写姓名" }]}>
              <Input placeholder="王妈妈" />
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
              <Input placeholder="wangmama@example.com" />
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
