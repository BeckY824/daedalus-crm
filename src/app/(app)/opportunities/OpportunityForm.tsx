"use client";

import { useEffect } from "react";
import { Input, Modal, Form, Row, Col, InputNumber, Select, DatePicker, Slider, App } from "antd";
import { OPP_STAGES, STAGE_PROBABILITY } from "@/lib/constants";
import { dayjs, 成员选项, 独自一人, type 可选成员 } from "@/lib/utils";
import { 金额格式 } from "@/lib/money-input";
import { saveOpportunity } from "./actions";
import type { OppRow } from "./OpportunitiesView";

/**
 * 新建 / 编辑商机的框。列表页和管道页共用（2026-09-29）：管道页原来没有表单，
 * 点「新建商机」要跳回列表页再打开——按钮写着新建，人却被带走了。
 *
 * **样子和字段顺序别动**：教程第 07 集就是在列表页点「新建商机」、依次填名称、选客户、写金额录的，
 * 这里只是把那一块原样挪出来。
 */
export default function OpportunityForm({
  open,
  editing,
  users,
  customers,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: OppRow | null;
  users: 可选成员[];
  customers: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm();

  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue({
        ...editing,
        expectedDealAt: editing.expectedDealAt ? dayjs(editing.expectedDealAt) : null,
      });
    } else {
      form.resetFields();
      // 金额不给默认值：原来默认 ¥100,000，忘了改就平白多出一单十万，直接进总额和加权预测
      form.setFieldsValue({
        stage: "初步沟通",
        status: "OPEN",
        probability: 20,
        ownerId: users[0]?.id,
      });
    }
  }, [open, editing, form, users]);


  async function onOk() {
    const v = await form.validateFields();
    const res = await saveOpportunity({
      id: editing?.id,
      ...v,
      expectedDealAt: v.expectedDealAt ? v.expectedDealAt.toISOString() : null,
    });
    if (!res.ok) {
      message.error(res.error);
      return;
    }
    message.success(editing ? "已保存" : "商机已创建");
    onSaved();
  }

  return (
    <Modal
      open={open}
      title={editing ? "编辑商机" : "新建商机"}
      onCancel={onClose}
      onOk={onOk}
      okText="保存"
      cancelText="取消"
      width={640}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
        <Row gutter={16}>
          <Col span={24}>
            <Form.Item name="name" label="商机名称" rules={[{ required: true, message: "请填写商机名称" }]}>
              <Input placeholder="如：CRM 系统企业版年度采购" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="customerId" label="所属客户" rules={[{ required: true, message: "请选择客户" }]}>
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="选择客户"
                options={customers.map((c) => ({ value: c.id, label: c.name }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="amount" label="商机金额（元）" rules={[{ required: true, message: "请填写商机金额" }]}>
              <InputNumber<number>
                min={0}
                step={10000}
                style={{ width: "100%" }}
                prefix="¥"
                placeholder="如 50,000"
                formatter={金额格式}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="stage" label="阶段">
              <Select
                options={OPP_STAGES.map((s) => ({ value: s, label: s }))}
                onChange={(v) => form.setFieldValue("probability", STAGE_PROBABILITY[v] ?? 20)}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="status" label="状态">
              <Select
                options={[
                  { value: "OPEN", label: "进行中" },
                  { value: "WON", label: "已赢单" },
                  { value: "LOST", label: "已丢单" },
                ]}
              />
            </Form.Item>
          </Col>
          {/* 只有一个人时不问归属，见 lib/utils.ts 的 独自一人 */}
          {!独自一人(users, editing?.ownerId) && (
            <Col span={8}>
              <Form.Item name="ownerId" label="负责人" rules={[{ required: true }]}>
                <Select options={成员选项(users)} />
              </Form.Item>
            </Col>
          )}
          <Col span={8}>
            <Form.Item name="expectedDealAt" label="预计成交">
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col span={16}>
            <Form.Item name="probability" label="成交概率 (%)">
              <Slider marks={{ 0: "0", 50: "50", 100: "100" }} />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="remark" label="备注">
              <Input.TextArea rows={2} placeholder="竞争对手、决策周期、风险点…" />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
