"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Col, Form, Input, Row, Select, Typography, App } from "antd";
import type { BusinessConfig } from "@/lib/business-config";
import { DEFAULT_BUSINESS, BUSINESS_PRESETS } from "@/lib/business-config";
import { FOLLOW_STATUSES, DECISION_STATUSES } from "@/lib/constants";
import { saveBusinessSettings } from "./actions";
import { DemoDataButton } from "@/components/EmptyState";

/**
 * 业务配置：把「客户 / 公司 / 职位 / 行业」这些措辞交给用户自己定。
 * 数据库列名与状态存储值都不动，改的只是显示与 AI 的语境。
 *
 * 顶上那两个预设是**填表的快捷方式**，不是一个新的配置项：点一下把整组字段填好，
 * 之后每一项照样能自己改，也要自己点保存。默认那套是通用销售，教培招生是另一套。
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

  /** 套用预设：只填表，不保存——人得自己看一眼再点保存，免得一次误点改掉全站措辞 */
  function 套用(名: string) {
    form.setFieldsValue(BUSINESS_PRESETS[名]);
    message.info(`已填入「${名}」这一套，看一眼再点保存`);
  }

  return (
    <div className="set-col" style={{ paddingTop: 8 }}>
      <div className="biz-preset">
        <span>套用预设</span>
        {Object.keys(BUSINESS_PRESETS).map((名) => (
          <Button key={名} size="small" onClick={() => 套用(名)}>
            {名}
          </Button>
        ))}
        <i>把下面整组填好，还能再改</i>
      </div>
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
            <Form.Item name="customer" label="客户叫什么" extra="如：客户 / 学员 / 会员" rules={[{ required: true, message: "必填" }, { max: 6, message: "6 字以内" }]}>
              <Input placeholder={DEFAULT_BUSINESS.customer} />
            </Form.Item>
          </Col>
          <Col xs={8} sm={6}>
            <Form.Item name={["fields", "school"]} label="档案字段 1" extra="默认「公司」" rules={[{ required: true, message: "必填" }, { max: 6, message: "6 字以内" }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={8} sm={6}>
            <Form.Item name={["fields", "grade"]} label="档案字段 2" extra="默认「职位」，是下拉选项" rules={[{ required: true, message: "必填" }, { max: 6, message: "6 字以内" }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={8} sm={6}>
            <Form.Item name={["fields", "major"]} label="档案字段 3" extra="默认「行业」" rules={[{ required: true, message: "必填" }, { max: 6, message: "6 字以内" }]}>
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

        <Typography.Title level={5} style={{ marginTop: 8 }}>状态显示名</Typography.Title>
        <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 12 }}>
          只改界面上叫什么，不改存储值——「已试听」「与家人商议」「已决定报名」这些值被盯盘、雷达、首页统计和终态判断直接引用。留空即用原名。
        </Typography.Paragraph>
        <Row gutter={[12, 0]}>
          {[...FOLLOW_STATUSES, ...DECISION_STATUSES].map((v) => (
            <Col xs={12} sm={8} md={6} key={v}>
              <Form.Item name={["statusLabels", v]} label={v} rules={[{ max: 8, message: "8 字以内" }]}>
                <Input placeholder={v} allowClear />
              </Form.Item>
            </Col>
          ))}
        </Row>

        <Button type="primary" onClick={onSave} loading={saving}>保存</Button>
        <Button type="text" style={{ marginLeft: 8 }} onClick={() => form.setFieldsValue(DEFAULT_BUSINESS)}>恢复默认</Button>
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 13 }}>
          不做的：自定义字段、自定义状态流转、多套模板切换——那是另一个量级的功能。
        </Typography.Paragraph>
      </Form>

      {/*
        演示数据的入口。**在这之前它只长在空状态里**——灌完之后列表不空了，
        那个卡片就再也不出现，于是「清除」成了一条走不到的路：灌过的人只能删库文件。
        摆在这一栏是因为它和业务配置是同一类事：都是「这个库长什么样」，都只有管理员能动。
      */}
      <div className="biz-demo">
        <h4>演示数据</h4>
        <p>一套虚构的客户、跟进和签约，用来看这套系统装满之后长什么样。清除会删掉库里**全部**业务数据。</p>
        <DemoDataButton />
      </div>
    </div>
  );
}
