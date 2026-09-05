"use client";

import { useState } from "react";
import { Modal, Form, Input, Select, Row, Col, DatePicker, App, Alert, Radio, Space, Typography, Button, Divider } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { FOLLOW_STATUSES, DECISION_STATUSES } from "@/lib/constants";
import { dayjs, 成员选项, 可选成员 } from "@/lib/utils";
import { saveCustomer, checkDuplicate, type DuplicateHit, type SaveConflict } from "./actions";
import { saveChannel } from "../channels/actions";
import { useBusiness } from "@/lib/business-client";

export type CustomerRow = {
  id: string;
  name: string;
  phone: string;
  school: string | null;
  grade: string | null;
  major: string | null;
  followStatus: string;
  decisionStatus: string;
  expectedSignAt: string | null;
  lastFollowAt: string | null;
  remark: string | null;
  /** 直接推荐人 */
  referrerCustomerId: string | null;
  channelId: string | null;
  referrerName: string | null;
  /** 渠道归属（往上两代）与渠道负责人，均由系统计算 */
  attributionName: string | null;
  channelOwnerName: string | null;
  salesOwnerId: string;
  salesOwnerName: string;
  signedAmount: number;
  /** 这条记录的版本号，保存时回传做并发校验 */
  updatedAt: string;
};

type Option = { id: string; name: string };

type FormProps = {
  open: boolean;
  editing: CustomerRow | null;
  users: 可选成员[];
  /** 外部渠道（如老师、中介） */
  channels: Option[];
  /** 已有学员，可作为推荐人 */
  customers: Option[];
  onClose: (saved: boolean) => void;
};

/**
 * 外层只负责挂载时机：用 key 让每次打开都重新挂载内层，
 * 表单初值与推荐人类型随之自然重置，不必在 effect 里同步 state。
 */
export default function CustomerForm(props: FormProps) {
  if (!props.open) return null;
  return <CustomerFormInner key={props.editing?.id ?? "new"} {...props} />;
}

function CustomerFormInner({
  open,
  editing,
  users,
  channels,
  customers,
  onClose,
}: FormProps) {
  const b = useBusiness();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dup, setDup] = useState<DuplicateHit | null>(null);
  /** 保存时发现别人已经改过这条记录 */
  const [conflict, setConflict] = useState<SaveConflict | null>(null);
  const [referrerType, setReferrerType] = useState<"channel" | "customer" | "none">(
    editing?.channelId ? "channel" : editing?.referrerCustomerId ? "customer" : "none",
  );
  /**
   * 渠道下拉的选项。以 props 为初值，但就地新建的渠道要立刻出现在这里——
   * 服务端的 revalidatePath 要等本弹窗关闭、页面重取数据才生效，等不及。
   */
  const [channelOptions, setChannelOptions] = useState<Option[]>(channels);
  /**
   * 负责人候选里不含管理员。但历史数据、或某人从销售改成管理员之后，
   * 已存在的记录仍可能挂在一个不在候选里的人名下——不补回去的话，
   * 下拉会显示空白，一保存就把负责人静默换成别人。
   */
  const 负责人选项 = 成员选项(users);
  if (editing && !users.some((u) => u.id === editing.salesOwnerId)) {
    负责人选项.push({ value: editing.salesOwnerId, label: `${editing.salesOwnerName}（已不再担任负责人）` });
  }

  /** 就地新建渠道的子弹窗 */
  const [channelModal, setChannelModal] = useState(false);
  /** 渠道下拉的开合。受控是因为点「新建」时必须先收起它——它的层级在子弹窗之上，不收会挡住表单 */
  const [channelOpen, setChannelOpen] = useState(false);

  /** 手机号失焦时查重，避免同一条线索被重复录入 */
  async function onPhoneBlur(e: React.FocusEvent<HTMLInputElement>) {
    const phone = e.target.value.trim();
    if (!phone) return setDup(null);
    setDup(await checkDuplicate(phone, editing?.id));
  }

  async function onOk() {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const res = await saveCustomer({
        id: editing?.id,
        updatedAt: editing?.updatedAt,
        // 打开表单那一刻的值。服务端靠它区分「对方改的」和「我改的」，
        // 只有双方改到同一字段才算冲突，否则自动合并
        base: editing
          ? {
              name: editing.name,
              phone: editing.phone,
              school: editing.school,
              grade: editing.grade,
              major: editing.major,
              followStatus: editing.followStatus,
              decisionStatus: editing.decisionStatus,
              expectedSignAt: editing.expectedSignAt ? new Date(editing.expectedSignAt) : null,
              remark: editing.remark,
              salesOwnerId: editing.salesOwnerId,
              channelId: editing.channelId,
              referrerCustomerId: editing.referrerCustomerId,
            }
          : null,
        name: v.name,
        phone: v.phone,
        school: v.school ?? null,
        grade: v.grade ?? null,
        major: v.major ?? null,
        followStatus: v.followStatus,
        decisionStatus: v.decisionStatus,
        expectedSignAt: v.expectedSignAt ? v.expectedSignAt.toDate() : null,
        remark: v.remark ?? null,
        salesOwnerId: v.salesOwnerId,
        channelId: referrerType === "channel" ? (v.channelId ?? null) : null,
        referrerCustomerId: referrerType === "customer" ? (v.referrerCustomerId ?? null) : null,
      });
      if (!res.ok) {
        // 并发冲突要留在原地把话说清楚，用一闪而过的 toast 说不明白
        if (res.conflict) {
          setConflict(res.conflict);
          return;
        }
        message.error(res.error);
        return;
      }
      message.success(editing ? "已保存" : `${b.customer}已创建`);
      onClose(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <Modal
      open={open}
      title={editing ? `编辑${b.customer}` : `新建${b.customer}`}
      onCancel={() => onClose(false)}
      onOk={onOk}
      confirmLoading={saving}
      okText="保存"
      cancelText="取消"
      width={760}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: 8 }}
        initialValues={
          editing
            ? { ...editing, expectedSignAt: editing.expectedSignAt ? dayjs(editing.expectedSignAt) : null }
            : { followStatus: "待跟进", decisionStatus: "了解中" }
        }
      >
        {conflict && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            title="有人和你改了同一项，你的改动没有保存"
            description={
              <>
                <div>
                  对方在 {dayjs(conflict.currentUpdatedAt).format("MM-DD HH:mm:ss")} 也改了这条记录，
                  你们都动了：<b>{conflict.fields.join("、")}</b>。
                  {conflict.theirFields.length > conflict.fields.length && (
                    <> 对方另外还改了：{conflict.theirFields
                      .filter((f) => !conflict.fields.includes(f))
                      .join("、")}。</>
                  )}
                </div>
                <div style={{ marginTop: 8 }}>
                  两个人改到同一项，系统不替你决定用谁的。请关闭后刷新，
                  看清对方填的是什么，再决定保留哪一个。
                </div>
              </>
            }
          />
        )}

        {dup && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            title="系统中已有这条线索"
            description={
              <span>
                {dup.name}
                {dup.school ? ` · ${dup.school}` : ""} · 销售负责人 {dup.salesOwnerName} · 录入于{" "}
                {dayjs(dup.createdAt).format("YYYY-MM-DD")}
              </span>
            }
          />
        )}

        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label="客户姓名" name="name" rules={[{ required: true, message: "请输入姓名" }]}>
              <Input placeholder="如：张三" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="联系电话"
              name="phone"
              rules={[
                { required: true, message: "请输入联系电话" },
                { pattern: /^1[3-9]\d{9}$/, message: "手机号格式不正确" },
              ]}
            >
              <Input placeholder="13800001111" onBlur={onPhoneBlur} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label={b.fields.school} name="school">
              <Input placeholder={b.fields.school === "院校" ? "如：北京大学" : undefined} />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label={b.fields.major} name="major">
              <Input placeholder={b.fields.major === "专业" ? "如：计算机科学与技术" : undefined} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label={b.fields.grade} name="grade">
              <Select allowClear placeholder="请选择" options={b.grades.map((g) => ({ value: g, label: g }))} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="销售负责人"
              name="salesOwnerId"
              rules={[{ required: true, message: "请选择销售负责人" }]}
              extra="负责谈单签约"
            >
              <Select placeholder="请选择" options={负责人选项} />
            </Form.Item>
          </Col>
        </Row>

        {/* 推荐人：决定渠道归属与渠道负责人，两者由系统按规则自动计算 */}
        <Form.Item label="推荐人" style={{ marginBottom: 12 }}>
          <Radio.Group
            value={referrerType}
            onChange={(e) => setReferrerType(e.target.value)}
            optionType="button"
            buttonStyle="solid"
            size="small"
          >
            <Radio value="none">无（自然流量）</Radio>
            <Radio value="channel">外部渠道</Radio>
            <Radio value="customer">已有{b.customer}</Radio>
          </Radio.Group>
        </Form.Item>

        {referrerType === "channel" && (
          <Form.Item name="channelId" rules={[{ required: true, message: "请选择推荐渠道" }]}>
            <Select
              showSearch
              placeholder="选择外部渠道，如：小红"
              optionFilterProp="label"
              options={channelOptions.map((c) => ({ value: c.id, label: c.name }))}
              open={channelOpen}
              onOpenChange={setChannelOpen}
              /**
               * 渠道往往是录学员的当场才第一次听说的。没有这个入口，
               * 用户就得放弃当前这一条、跑去渠道管理建完再回来重填。
               */
              popupRender={(menu) => (
                <>
                  {menu}
                  <Divider style={{ margin: "6px 0" }} />
                  <Button
                    type="link"
                    icon={<PlusOutlined />}
                    style={{ paddingInline: 12 }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setChannelOpen(false);
                      setChannelModal(true);
                    }}
                  >
                    新建外部渠道
                  </Button>
                </>
              )}
            />
          </Form.Item>
        )}

        {referrerType === "customer" && (
          <Form.Item name="referrerCustomerId" rules={[{ required: true, message: `请选择推荐${b.customer}` }]}>
            <Select
              showSearch
              placeholder={`选择已有${b.customer}`}
              optionFilterProp="label"
              options={customers.map((c) => ({ value: c.id, label: c.name }))}
            />
          </Form.Item>
        )}

        {referrerType !== "none" && (
          <Typography.Text type="secondary" style={{ display: "block", marginBottom: 16, fontSize: 13 }}>
            渠道归属与渠道负责人由系统按推荐链自动计算，保存后可在详情页查看
          </Typography.Text>
        )}

        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label="跟进状态" name="followStatus" rules={[{ required: true }]}>
              <Select options={FOLLOW_STATUSES.map((s) => ({ value: s, label: s }))} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="客户决策状态" name="decisionStatus" rules={[{ required: true }]}>
              <Select options={DECISION_STATUSES.map((s) => ({ value: s, label: s }))} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="预计签约时间" name="expectedSignAt">
              <DatePicker style={{ width: "100%" }} placeholder="选择日期" />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item label="备注" name="remark">
          <Input.TextArea rows={3} placeholder={`${b.customer}背景、意向、注意事项…`} />
        </Form.Item>

        <Space />
      </Form>
    </Modal>

    <QuickChannelModal
      open={channelModal}
      users={users}
      onClose={(created) => {
        setChannelModal(false);
        if (!created) return;
        setChannelOptions((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name, "zh")));
        // 建完就替用户选上——不然还得再点开下拉找一遍，等于没省事
        form.setFieldValue("channelId", created.id);
        form.validateFields(["channelId"]);
      }}
    />
    </>
  );
}

/**
 * 「新建学员」里就地建渠道用的小弹窗。字段与「渠道管理」保持一致：
 * 渠道负责人是必填项，它决定这条推荐链上所有学员归谁，不能省。
 */
function QuickChannelModal({
  open,
  users,
  onClose,
}: {
  open: boolean;
  users: 可选成员[];
  onClose: (created: Option | null) => void;
}) {
  const b = useBusiness();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  async function onOk() {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const res = await saveChannel({
        name: v.name,
        phone: v.phone ?? null,
        remark: v.remark ?? null,
        channelOwnerId: v.channelOwnerId,
      });
      if (!res.ok) {
        // 重名是这里最常见的失败，留在原地让用户改名字，别关掉弹窗
        message.error(res.error);
        return;
      }
      message.success(`渠道「${v.name}」已创建`);
      onClose({ id: res.id, name: v.name.trim() });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title="新建外部渠道"
      onCancel={() => onClose(null)}
      onOk={onOk}
      confirmLoading={saving}
      okText="创建"
      cancelText="取消"
      width={460}
      destroyOnHidden
      // 盖在「新建学员」上层，否则会被它的遮罩挡住
      zIndex={1100}
    >
      {/* name 前缀不能省：这个表单和「新建学员」同时在 DOM 里，
          字段名又都叫 name/phone/remark，不加前缀 label 会绑到学员那几个框上 */}
      <Form form={form} name="quickChannel" layout="vertical" style={{ marginTop: 8 }}>
        <Form.Item label="渠道姓名" name="name" rules={[{ required: true, message: "请输入渠道姓名" }]}>
          <Input placeholder="如：小红" />
        </Form.Item>
        <Form.Item label="联系电话" name="phone">
          <Input placeholder="选填" />
        </Form.Item>
        <Form.Item
          label="渠道负责人"
          name="channelOwnerId"
          rules={[{ required: true, message: "请选择渠道负责人" }]}
          extra={`该渠道带来的${b.customer}及其下游转介绍，渠道负责人都归此人`}
        >
          <Select placeholder="请选择" options={成员选项(users)} />
        </Form.Item>
        <Form.Item label="备注" name="remark">
          <Input.TextArea rows={2} placeholder="选填" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
