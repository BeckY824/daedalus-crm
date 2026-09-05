"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Col, Form, Input, Row, Select, Typography, App } from "antd";
import type { BusinessConfig } from "@/lib/business-config";
import { DEFAULT_BUSINESS } from "@/lib/business-config";
import { saveBusinessSettings } from "./actions";

/**
 * 业务配置：把「学员 / 院校 / 年级 / 专业 / 教培销售」这些措辞交给用户自己定。
 * 数据库列名与状态存储值都不动，改的只是显示与 AI 的语境。
 */
export default function BusinessSettingsTab({ value }: { value: BusinessConfig }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [form] = Form.useForm<BusinessConfig>();
  const [saving, setSaving] = useState(false);

  async function onSave() {
    const v = await form.validateFields();
    setSaving(true);
    const res = await saveBusinessSettings(v);
    setSaving(false);
    if (res.ok) {
      message.success("已保存，全站措辞已更新");
      router.refresh();
    } else message.error(res.error);
  }

  const tags = (placeholder: string) => (
    <Select mode="tags" tokenSeparators={[",", "，", "\n"]} placeholder={placeholder} open={false} suffixIcon={null} />
  );

  return (
    <div style={{ maxWidth: 720, paddingTop: 8 }}>
      <Form form={form} layout="vertical" initialValues={value}>
        <Form.Item
          name="brief"
          label="业务简介"
          extra="一段话：你们卖什么、客户是谁、怎么成交。会注入全部 AI 功能的提示词，改这一段，速记、简报、问数据、唤醒与邀请话术全部跟着换语境。"
          rules={[{ required: true, message: "请写一段业务简介" }, { max: 500, message: "500 字以内" }]}
        >
          <Input.TextArea rows={3} showCount maxLength={500} />
        </Form.Item>

        <Row gutter={16}>
          <Col xs={24} sm={6}>
            <Form.Item name="customer" label="客户叫什么" extra="如：学员 / 客户 / 会员" rules={[{ required: true, message: "必填" }, { max: 6, message: "6 字以内" }]}>
              <Input placeholder={DEFAULT_BUSINESS.customer} />
            </Form.Item>
          </Col>
          <Col xs={8} sm={6}>
            <Form.Item name={["fields", "school"]} label="档案字段 1" extra="默认「院校」" rules={[{ required: true, message: "必填" }, { max: 6, message: "6 字以内" }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={8} sm={6}>
            <Form.Item name={["fields", "grade"]} label="档案字段 2" extra="默认「年级」，是下拉选项" rules={[{ required: true, message: "必填" }, { max: 6, message: "6 字以内" }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={8} sm={6}>
            <Form.Item name={["fields", "major"]} label="档案字段 3" extra="默认「专业」" rules={[{ required: true, message: "必填" }, { max: 6, message: "6 字以内" }]}>
              <Input />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item name="grades" label="档案字段 2 的选项" extra="回车或逗号分隔。删掉某项不会影响已存了该值的记录，只是新录入时选不到。" rules={[{ required: true, message: "至少一项" }]}>
          {tags("大一、大二…")}
        </Form.Item>
        <Form.Item name="sources" label="线索来源选项" rules={[{ required: true, message: "至少一项" }]}>
          {tags("官网注册、转介绍…")}
        </Form.Item>
        <Form.Item name="industries" label="线索行业选项" rules={[{ required: true, message: "至少一项" }]}>
          {tags("教育培训、设计服务…")}
        </Form.Item>

        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          title="跟进状态与决策状态的取值不在这里改"
          description="「已试听」「与家人商议」「已决定报名」这些值被盯盘、转介绍雷达、首页统计和终态判断直接引用，改了会让统计失真。这一项在路线图上。"
        />

        <Button type="primary" onClick={onSave} loading={saving}>保存</Button>
        <Button type="text" style={{ marginLeft: 8 }} onClick={() => form.setFieldsValue(DEFAULT_BUSINESS)}>恢复默认</Button>
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12.5 }}>
          不做的：自定义字段、自定义状态流转、多套模板切换——那是另一个量级的功能。
        </Typography.Paragraph>
      </Form>
    </div>
  );
}
