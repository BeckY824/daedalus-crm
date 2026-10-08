"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Col, Form, Input, InputNumber, Radio, Row, Select, Typography, App } from "antd";
import type { BusinessConfig, BusinessTemplate } from "@/lib/business-config";
import { DEFAULT_BUSINESS, BUSINESS_PRESETS, RELABELABLE_STATUSES, 表单公海天数, 模版预设, statusLabel, 状态名问题 } from "@/lib/business-config";
import { 币种选项 } from "@/lib/currency";
import { FOLLOW_STATUSES, DECISION_STATUSES } from "@/lib/constants";
import { saveBusinessSettings } from "./actions";
import { DemoDataSection } from "@/components/EmptyState";

/**
 * 业务配置：把「客户 / 公司 / 职位 / 行业」这些措辞交给用户自己定。
 * 数据库列名与状态存储值都不动，改的只是显示与 AI 的语境。
 *
 * 顶上那几个预设是**填表的快捷方式**，不是一个新的配置项：点一下把整组字段填好，
 * 之后每一项照样能自己改，也要自己点保存。默认那套是通用销售，教培招生和外贸出口各是一套。
 */
export default function BusinessSettingsTab({ value, 多人 = false }: { value: BusinessConfig; /** 在职的不止一个人：才摆公海那一项 */ 多人?: boolean }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [form] = Form.useForm<BusinessConfig>();
  const [saving, setSaving] = useState(false);
  const 旧状态有冲突 = Object.keys(状态名问题(value)).length > 0;
  /**
   * 刚套上、还没保存的那一套（审查 D7）。原来点预设只飘过一句提示，保存键在长表单最底下，
   * 界面上看不出「这些改动还没生效」。现在就在预设那一行说，保存 / 放弃也在那一行
   */
  const [套了, set套了] = useState<string | null>(null);

  async function onSave() {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const 状态错误 = 状态名问题(v);
    if (Object.keys(状态错误).length) {
      form.setFields(Object.entries(状态错误).map(([key, error]) => ({ name: ["statusLabels", key], errors: [error] })));
      message.error(Object.values(状态错误)[0]);
      return;
    }
    setSaving(true);
    // 摆着这一项时清空 = 不开（存 0）；没摆时表单里没有它，照原值存回去，别悄悄关掉（表单公海天数，T-044 有用例）
    try {
    const res = await saveBusinessSettings({ ...v, poolDays: 表单公海天数(v.poolDays, 多人, value.poolDays) });
    if (res.ok) {
      set套了(null);
      message.success(res.补了来源 ? `已保存，全站措辞已更新；${res.补了来源} 位${v.customer ?? "客户"}的来源从渠道 / 线索补了过来` : "已保存，全站措辞已更新");
      router.refresh();
    } else message.error(res.error);
    } catch {
      message.error("保存失败，请刷新核对后重试；当前填写内容仍保留");
    } finally {
      setSaving(false);
    }
  }

  const tags = (placeholder: string) => (
    <Select mode="tags" tokenSeparators={[",", "，", "\n"]} placeholder={placeholder} open={false} suffixIcon={null} />
  );

  /** 套用预设：只填表，不保存——人得自己看一眼再点保存，免得一次误点改掉全站措辞 */
  function 套用(名: string) {
    // 预设只管措辞：公海天数不是措辞，不跟着变
    const 预设 = BUSINESS_PRESETS[名];
    /*
      状态叫法每一条都显式填（预设里没有的填空 = 用原名）：setFieldsValue 对嵌套对象是**合并**，
      从外贸切回通用时，通用预设里没有的「已签约 → 已下单」「已加微信 → 已建联」留在表单里一起存了（2026-10-06 F.2 走查）
    */
    const 叫法 = Object.fromEntries(RELABELABLE_STATUSES.map((k) => [k, 预设.statusLabels?.[k] ?? ""]));
    form.setFieldsValue({ ...预设, statusLabels: 叫法, poolDays: form.getFieldValue("poolDays") ?? value.poolDays });
    set套了(名);
  }
  function 放弃() {
    form.resetFields();
    set套了(null);
  }

  return (
    <div className="set-col" style={{ paddingTop: 8 }}>
      <div className="biz-preset">
        <span>套用预设</span>
        {/* 教培那套不再给新用户（10-03：只有通用和外贸两个模版）；正在用它的老用户还看得到，免得「恢复」不回去 */}
        {Object.keys(BUSINESS_PRESETS).filter((名) => 名 !== "教培招生" || value.fields.school === "院校").map((名) => (
          <Button key={名} size="small" type={套了 === 名 ? "primary" : "default"} ghost={套了 === 名} onClick={() => 套用(名)}>
            {名}
          </Button>
        ))}
        {套了 ? (
          <span className="biz-preset-todo" role="status">
            已填入「{套了}」，还没保存
            <Button size="small" type="primary" loading={saving} onClick={onSave}>保存</Button>
            <Button size="small" type="text" onClick={放弃}>放弃</Button>
          </span>
        ) : (
          <i>把下面整组填好，还能再改</i>
        )}
      </div>
      <Form form={form} layout="vertical" initialValues={value}>
        <Row gutter={16}>
          <Col xs={24} sm={12}>
            <Form.Item
              name="template"
              label="模版"
              extra="外贸模版换成询盘、报价、寄样这套叫法，默认美元；每一项都能在下面再改。"
            >
              {/*
                换模版 = 套用那个模版的预设（2026-10-05）：原来只改这一格，订单、国家这些出来了，职位、来源、阶段叫法却还是原来那套，
                「已签约」也不改叫「已下单」——要人再去点「套用预设」才齐。现在一点就整组填好，和点预设一样还要「保存」才生效
              */}
              <Radio.Group
                optionType="button"
                options={[{ value: "general", label: "通用" }, { value: "trade", label: "外贸" }]}
                onChange={(e) => 套用(模版预设[e.target.value as BusinessTemplate])}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="currency" label="本位币" extra="新建商机、订单 / 签约时默认选它；已经填好的金额不跟着变。" rules={[{ required: true, message: "选一个" }]}>
              <Select showSearch optionFilterProp="label" options={币种选项()} style={{ maxWidth: 260 }} />
            </Form.Item>
          </Col>
        </Row>
        {多人 && (
          <Form.Item
            name="poolDays"
            label="自动放进公海"
            extra={`多少天没跟进就自动放进公海，谁都能领；${statusLabel(value, "已签约")}、${statusLabel(value, "已流失")}的不放。填 0 不开。团队同步时全团队一份。`}
          >
            <InputNumber min={0} max={365} precision={0} suffix="天" style={{ width: 140 }} />
          </Form.Item>
        )}
        <Form.Item
          name="brief"
          label="业务简介"
          /* 右下角那个字数是绝对定位的，会压在 extra 这段说明上，靠 .field-count 让出一行 */
          className="field-count"
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
        <Form.Item name="sources" label="线索来源选项" extra="录入时的候选；不在这里的也能直接填。" rules={[{ required: true, message: "至少一项" }]}>
          {tags("微信、小红书、抖音、转介绍…")}
        </Form.Item>
        <Form.Item name="industries" label="行业选项" extra="线索和客户的「行业」都用这份当候选，也能直接填。" rules={[{ required: true, message: "至少一项" }]}>
          {tags("教育培训、设计服务…")}
        </Form.Item>

        <Typography.Title level={5} style={{ marginTop: 8 }}>状态显示名</Typography.Title>
        {旧状态有冲突 && <Alert type="warning" showIcon title="已有状态显示名冲突" description="页面会附上原状态以便区分。请在下面修正重复或借用其他状态的名称后保存。" style={{ marginBottom: 12 }} />}
        <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 12 }}>
          留空即用原名。各状态名称不能重复，也不能借用其他状态或预设的名称；改名不会改变状态对应的统计和流程。
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
        <Button type="text" style={{ marginLeft: 8 }} onClick={() => 套用("通用销售")}>恢复默认</Button>
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 13 }}>
          不做的：自定义字段、自定义状态流转——那是另一个量级的功能。
        </Typography.Paragraph>
      </Form>

      {/*
        演示数据的入口。**在这之前它只长在空状态里**——灌完之后列表不空了，
        那个卡片就再也不出现，于是「清除」成了一条走不到的路：灌过的人只能删库文件。
        摆在这一栏是因为它和业务配置是同一类事：都是「这个库长什么样」，都只有管理员能动。
        整栏出不出现由 DemoDataSection 自己判断——桌面端不给灌，那边连标题都不该有。
      */}
      <DemoDataSection />
    </div>
  );
}
