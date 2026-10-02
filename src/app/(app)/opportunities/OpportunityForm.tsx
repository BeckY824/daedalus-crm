"use client";

import { useEffect, useRef } from "react";
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
  /** 换阶段前是哪一档：概率还等于那一档的默认值，才算「人没动过」、跟着换（排查 D6） */
  const 上一个阶段 = useRef("初步沟通");

  useEffect(() => {
    if (!open) return;
    上一个阶段.current = editing?.stage ?? "初步沟通";
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
        probability: STAGE_PROBABILITY["初步沟通"] ?? 20,
        ownerId: users[0]?.id,
      });
    }
  }, [open, editing, form, users]);


  async function onOk() {
    const v = await form.validateFields();
    const res = await saveOpportunity({
      id: editing?.id,
      版本: editing?.updatedAt,
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
                /*
                  和拖拽同一个规矩（moveStage）：概率只在人没动过时跟着阶段变，手填的 75% 不冲掉；
                  原来一换阶段就覆盖（排查 D6）。赢单成交一律 100
                */
                onChange={(v: string) => {
                  const 现在 = form.getFieldValue("probability") as number | undefined;
                  const 人没动过 = 现在 == null || 现在 === (STAGE_PROBABILITY[上一个阶段.current] ?? 20);
                  if (v === "赢单成交") form.setFieldValue("probability", 100);
                  else if (人没动过 || 上一个阶段.current === "赢单成交") form.setFieldValue("probability", STAGE_PROBABILITY[v] ?? 20);
                  // 阶段和状态当场对上（服务端 对齐阶段与状态 同一个规矩），保存前人就看得见会存成什么
                  if (v === "赢单成交") form.setFieldValue("status", "WON");
                  else if (form.getFieldValue("status") === "WON") form.setFieldValue("status", "OPEN");
                  上一个阶段.current = v;
                }}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="status" label="状态">
              <Select
                onChange={(v: string) => {
                  const 阶段 = form.getFieldValue("stage") as string;
                  if (v === "WON" && 阶段 !== "赢单成交") {
                    form.setFieldValue("stage", "赢单成交");
                    form.setFieldValue("probability", 100);
                    上一个阶段.current = "赢单成交";
                  } else if (v !== "WON" && 阶段 === "赢单成交") {
                    // 赢了的单后来黄了：阶段退回前一档，不能挂在「赢单成交」上
                    const 前一档 = OPP_STAGES[OPP_STAGES.indexOf("赢单成交") - 1];
                    form.setFieldValue("stage", 前一档);
                    form.setFieldValue("probability", STAGE_PROBABILITY[前一档] ?? 20);
                    上一个阶段.current = 前一档;
                  }
                }}
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
                {/* 现任不在候选里（管理员、已停用）时补进去，不然下拉显示一串 id，一保存还可能被换掉（排查 D8） */}
                <Select
                  options={[
                    ...(editing && !users.some((u) => u.id === editing.ownerId)
                      ? [{ value: editing.ownerId, label: `${editing.ownerName}（不在候选里）` }]
                      : []),
                    ...成员选项(users),
                  ]}
                />
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
