"use client";

import { useEffect } from "react";
import { Modal, Form, Input, Switch, Row, Col, App, AutoComplete, Select, Button } from "antd";
import { saveContact, saveUnassignedContact } from "./actions";
import type { ContactRow } from "./types";
import { useBusiness } from "@/lib/business-client";
import { 关系候选 } from "@/lib/business-config";

/*
  与客户的关系。取值有限却不封闭（教培里有姑姑、哥哥，公司里有「副总」），
  所以用 AutoComplete 给常用项、同时允许自己填，不用 Select 硬约束。
  候选跟着业务配置走（lib/business-config.ts 的 关系候选，审查 M14）。

  数据库列名仍是 position（原本是 To B 的「职务」），
  改列要动迁移，而迁移纪律是只增不改；列名是内部的，界面上叫什么才是用户看到的。
*/

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
  未归属 = false,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** 记录页上给定；列表页上不给，改由表单里选 */
  customerId?: string;
  /** 只有不给 customerId 时才用得上：可选的学员 */
  学员们?: { id: string; name: string }[];
  record: ContactRow | null;
  /**
   * 改的是一位从客户上移出的联系人（联系人页里写「未归属」那种）。
   * 这时「所属」可以不挑——不挑就还留在未归属，挑了就是挂回去
   */
  未归属?: boolean;
  /** 给了就在左下角摆「彻底删除」。联系人页上未归属的人只有这儿能删 */
  onDelete?: () => void;
}) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const b = useBusiness();
  const 挑的 = Form.useWatch("customerId", form) as string | undefined;
  /** 未归属又还没挑客户：谈不上是谁的关键联系人，那个开关不摆 */
  const 还没归属 = 未归属 && !挑的;

  useEffect(() => {
    if (!open) return;
    if (record) form.setFieldsValue({ ...record, customerId: undefined });
    else {
      form.resetFields();
      form.setFieldsValue({ isPrimary: false });
    }
  }, [open, record, form]);

  async function onOk() {
    const v = await form.validateFields();
    // 记录页给的 customerId 说了算；列表页上它在表单里
    const 归属 = customerId ?? (v.customerId as string);
    if (未归属 && record) {
      // 未归属的人：挑了客户就是挂过去，不挑就还留在未归属、只改资料
      const r = await saveUnassignedContact({ id: record.id, ...v, isPrimary: Boolean(v.isPrimary), customerId: 归属 || null });
      if (!r.ok) return void message.error(r.error);
      message.success(r.挂到 ? `已挂到「${r.挂到}」` : "已保存");
      return void onSaved();
    }
    await saveContact({ id: record?.id, ...v, isPrimary: Boolean(v.isPrimary), customerId: 归属 });
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
      footer={(原来的) =>
        onDelete ? (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Button danger type="text" onClick={onDelete}>
              彻底删除
            </Button>
            <div style={{ display: "flex", gap: 8 }}>{原来的}</div>
          </div>
        ) : (
          原来的
        )
      }
    >
      <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
        <Row gutter={16}>
          {/* 从联系人列表进来时先选人：联系人挂在某一位学员下面，没有归属的联系人没有意义 */}
          {!customerId && (
            <Col span={24}>
              <Form.Item
                name="customerId"
                label={`所属${b.customer}`}
                rules={未归属 ? [] : [{ required: true, message: `请选择所属${b.customer}` }]}
                extra={未归属 && !挑的 ? `现在不在任何${b.customer}下面。挑一位就挂过去，不挑就还留在未归属` : undefined}
              >
                <Select
                  showSearch
                  allowClear={未归属}
                  optionFilterProp="label"
                  placeholder={未归属 ? `未归属（挑一位${b.customer}挂过去）` : `搜索并选择一位${b.customer}`}
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
              <AutoComplete options={关系候选(b).map((v) => ({ value: v }))} placeholder={关系候选(b)[0]} />
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
          {!还没归属 && (
            <Col span={12}>
              <Form.Item name="isPrimary" label="关键联系人" valuePropName="checked">
                <Switch checkedChildren="是" unCheckedChildren="否" />
              </Form.Item>
            </Col>
          )}
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
