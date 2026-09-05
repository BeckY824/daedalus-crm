"use client";

import { useEffect, useState } from "react";
import { Modal, Form, Input, Select, DatePicker, InputNumber, Row, Col, App, Button, Checkbox, Space, Typography } from "antd";
import { ThunderboltOutlined } from "@ant-design/icons";
import { FOLLOW_TYPES, FOLLOW_RECORD_STATUSES } from "@/lib/constants";
import { dayjs, fmtDateTime } from "@/lib/utils";
import { saveFollowUp, saveTask, savePlan } from "./actions";
import { parseFollowUpDraft } from "./ai";

type Rec = {
  id?: string;
  type?: string;
  title?: string;
  content?: string;
  status?: string;
  duration?: number | null;
  occurredAt?: string;
  dueAt?: string | null;
  contactId?: string | null;
  opportunityId?: string | null;
  participants?: string | null;
};

/** AI 速记解析出的"顺带创建"项，勾选后随跟进一起保存 */
type Extras = {
  tasks: { title: string; dueAt: string | null; checked: boolean }[];
  plan: { subject: string; plannedAt: string; method: string; checked: boolean } | null;
  followStatusSuggestion: string | null;
  decisionStatusSuggestion: string | null;
};

export default function FollowUpForm({
  open,
  onClose,
  onSaved,
  customerId,
  record,
  contacts,
  opportunities,
  aiEnabled,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  customerId: string;
  record: Rec | null;
  contacts: { id: string; name: string; position: string | null }[];
  opportunities: { id: string; name: string }[];
  aiEnabled: boolean;
}) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const type = Form.useWatch("type", form);

  const [aiText, setAiText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [extras, setExtras] = useState<Extras | null>(null);

  // AI 面板的状态在关闭/保存的事件处理里重置（见 resetAi），
  // 不放进 effect——react-hooks/set-state-in-effect 禁止，且事件里重置语义更准
  function resetAi() {
    setAiText("");
    setExtras(null);
  }

  useEffect(() => {
    if (!open) return;
    if (record?.id) {
      form.setFieldsValue({
        ...record,
        occurredAt: dayjs(record.occurredAt),
        dueAt: record.dueAt ? dayjs(record.dueAt) : null,
        durationMinutes: record.duration ? Math.round(record.duration / 60) : null,
      });
    } else {
      form.resetFields();
      form.setFieldsValue({
        type: record?.type ?? "PHONE",
        status: "已完成",
        occurredAt: dayjs(),
      });
    }
  }, [open, record, form]);

  async function onAiParse() {
    if (aiText.trim().length < 5) {
      message.warning("先把沟通过程随手写几句");
      return;
    }
    setAiLoading(true);
    const res = await parseFollowUpDraft({ customerId, text: aiText });
    setAiLoading(false);
    if (!res.ok) {
      message.error(res.error);
      return;
    }
    const d = res.draft;
    form.setFieldsValue({
      type: d.followUp.type,
      status: d.followUp.status,
      title: d.followUp.title || undefined,
      content: d.followUp.content,
      durationMinutes: d.followUp.durationMinutes,
      occurredAt: d.followUp.occurredAt ? dayjs(d.followUp.occurredAt) : dayjs(),
      contactId: d.followUp.contactId ?? undefined,
      opportunityId: d.followUp.opportunityId ?? undefined,
    });
    setExtras({
      tasks: d.tasks.map((t) => ({ ...t, checked: true })),
      plan: d.plan ? { ...d.plan, checked: true } : null,
      followStatusSuggestion: d.followStatusSuggestion,
      decisionStatusSuggestion: d.decisionStatusSuggestion,
    });
    message.success("已按原话预填，请核对后保存");
  }

  async function onOk() {
    const v = await form.validateFields();
    const res = await saveFollowUp({
      id: record?.id,
      customerId,
      type: v.type,
      title: v.title,
      content: v.content,
      status: v.status,
      durationMinutes: v.durationMinutes ?? null,
      occurredAt: v.occurredAt.toISOString(),
      dueAt: v.dueAt ? v.dueAt.toISOString() : null,
      contactId: v.contactId ?? null,
      opportunityId: v.opportunityId ?? null,
      participants: v.participants ?? null,
    });
    // 校验不通过时必须如实报错，否则界面照样提示成功、人以为已经存下了
    if (!res.ok) {
      message.error(res.error);
      return;
    }

    // AI 顺带解析出的待办/计划，只创建勾选的；失败不吞——跟进本体已存上，
    // 但要让人知道哪部分要手工补，不能让"部分成功"伪装成"全部成功"
    if (!record?.id && extras) {
      const jobs: Promise<{ ok: boolean }>[] = [];
      for (const t of extras.tasks) {
        if (t.checked) jobs.push(saveTask({ customerId, title: t.title, dueAt: t.dueAt }));
      }
      if (extras.plan?.checked) {
        jobs.push(
          savePlan({
            customerId,
            subject: extras.plan.subject,
            plannedAt: extras.plan.plannedAt,
            method: extras.plan.method,
          }),
        );
      }
      if (jobs.length) {
        const results = await Promise.allSettled(jobs);
        const failed = results.filter((r) => r.status === "rejected" || !r.value.ok).length;
        if (failed > 0) {
          message.warning(`跟进已保存，但有 ${failed} 项待办/计划创建失败，请手动补建`);
          resetAi();
          onSaved();
          return;
        }
      }
    }

    message.success(record?.id ? "已保存" : "跟进已记录");
    resetAi();
    onSaved();
  }

  const showDuration = type === "PHONE" || type === "MEETING";
  const showDue = type === "TASK" || type === "REMIND";
  const showAi = aiEnabled && !record?.id;
  const suggestions = [
    extras?.followStatusSuggestion ? `跟进状态 → ${extras.followStatusSuggestion}` : null,
    extras?.decisionStatusSuggestion ? `决策状态 → ${extras.decisionStatusSuggestion}` : null,
  ].filter(Boolean);

  return (
    <Modal
      open={open}
      title={record?.id ? "编辑跟进记录" : "新建跟进"}
      onCancel={() => {
        resetAi();
        onClose();
      }}
      onOk={onOk}
      okText="保存"
      cancelText="取消"
      width={640}
      destroyOnHidden
    >
      {showAi && (
        <div
          style={{
            background: "#f6f9fe",
            border: "1px solid #dbe8fa",
            borderRadius: 8,
            padding: "12px 14px",
            marginTop: 8,
          }}
        >
          <Input.TextArea
            value={aiText}
            onChange={(e) => setAiText(e.target.value)}
            autoSize={{ minRows: 2, maxRows: 6 }}
            maxLength={5000}
            placeholder={'跟进速记：把沟通过程随手倒出来，或直接粘贴微信聊天记录，AI 帮你填表。\n如："刚跟王妈妈打了20分钟，她担心孩子时间不够，想先试两节课，下周三晚上再约她聊报价"'}
          />
          <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              解析结果只是预填，核对无误再保存
            </Typography.Text>
            <Button size="small" type="primary" ghost icon={<ThunderboltOutlined />} loading={aiLoading} onClick={onAiParse}>
              AI 解析填表
            </Button>
          </div>
        </div>
      )}

      <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name="type" label="跟进类型" rules={[{ required: true }]}>
              <Select options={FOLLOW_TYPES.map((t) => ({ value: t.value, label: t.label }))} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="status" label="状态">
              <Select options={FOLLOW_RECORD_STATUSES.map((s) => ({ value: s, label: s }))} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="occurredAt" label="发生时间" rules={[{ required: true }]}>
              <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
            </Form.Item>
          </Col>

          <Col span={24}>
            {/* 选填：时间线上已有跟进类型，标题只在需要一句话概括时才有意义 */}
            <Form.Item name="title" label="标题" extra="选填，填了会显示在跟进记录上">
              <Input placeholder="如：与王妈妈沟通试听安排与报价" />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="content" label="沟通内容" rules={[{ required: true, message: "请填写沟通内容" }]}>
              <Input.TextArea rows={4} placeholder="记录沟通要点、客户反馈、下一步动作…" />
            </Form.Item>
          </Col>

          <Col span={12}>
            <Form.Item name="contactId" label="对接联系人">
              <Select
                allowClear
                placeholder="选择联系人"
                options={contacts.map((c) => ({
                  value: c.id,
                  label: c.position ? `${c.name}（${c.position}）` : c.name,
                }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="opportunityId" label="关联商机">
              <Select allowClear placeholder="选择商机" options={opportunities.map((o) => ({ value: o.id, label: o.name }))} />
            </Form.Item>
          </Col>

          {showDuration && (
            <Col span={12}>
              <Form.Item name="durationMinutes" label="时长（分钟）">
                <InputNumber min={0} max={600} style={{ width: "100%" }} placeholder="如 18" />
              </Form.Item>
            </Col>
          )}
          {showDue && (
            <Col span={12}>
              <Form.Item name="dueAt" label={type === "TASK" ? "截止时间" : "提醒时间"}>
                <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          )}
          {type === "MEETING" && (
            <Col span={12}>
              <Form.Item name="participants" label="参与人" tooltip="多人用逗号分隔">
                <Input placeholder="王妈妈, 王同学" />
              </Form.Item>
            </Col>
          )}
        </Row>
      </Form>

      {extras && !record?.id && (extras.tasks.length > 0 || extras.plan || suggestions.length > 0) && (
        <div style={{ borderTop: "1px dashed #e2e8f2", paddingTop: 12, marginTop: 4 }}>
          <Space orientation="vertical" size={6} style={{ width: "100%" }}>
            {extras.tasks.map((t, i) => (
              <Checkbox
                key={i}
                checked={t.checked}
                onChange={(e) =>
                  setExtras({
                    ...extras,
                    tasks: extras.tasks.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)),
                  })
                }
              >
                同时创建待办：{t.title}
                {t.dueAt ? `（截止 ${fmtDateTime(t.dueAt)}）` : ""}
              </Checkbox>
            ))}
            {extras.plan && (
              <Checkbox
                checked={extras.plan.checked}
                onChange={(e) => setExtras({ ...extras, plan: { ...extras.plan!, checked: e.target.checked } })}
              >
                同时创建下次跟进计划：{extras.plan.subject} · {fmtDateTime(extras.plan.plannedAt)} · {extras.plan.method}
              </Checkbox>
            )}
            {suggestions.length > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                AI 建议：{suggestions.join("；")}（如认可，请到「编辑学员」里修改）
              </Typography.Text>
            )}
          </Space>
        </div>
      )}
    </Modal>
  );
}
