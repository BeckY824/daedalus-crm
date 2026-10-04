"use client";

import OptionInput from "@/components/OptionInput";
import { useState } from "react";
import { Alert, App, AutoComplete, Button, Col, DatePicker, Divider, Form, Input, Modal, Radio, Row, Select, Space, Typography } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { FOLLOW_STATUSES, DECISION_STATUSES } from "@/lib/constants";
import { dayjs, 成员选项, 独自一人, 可选成员 } from "@/lib/utils";
import { useMe, 默认负责人 } from "@/lib/me-client";
import { saveCustomer, checkDuplicate, type DuplicateHit, type SaveConflict } from "./actions";
import { saveChannel } from "../channels/actions";
import { useBusiness } from "@/lib/business-client";
import { statusLabel } from "@/lib/business-config";
import { 查电话 } from "@/lib/phone";
import { 推荐方式 } from "@/lib/referrer-kind";
import { 带走说法 } from "@/lib/carry-over";
import { 聚焦首项 } from "@/lib/modal-focus";
import { 字段是公司, 字段是行业 } from "@/lib/lead-convert";

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
  /** 渠道归属（往上两代）由系统计算；渠道负责人默认跟着推荐链，但可以单独订正 */
  attributionName: string | null;
  channelOwnerId: string | null;
  channelOwnerName: string | null;
  salesOwnerId: string;
  salesOwnerName: string;
  /** 各笔签约金额直接相加——**只拿来排序和判断签没签过**，显示用 signedTotals（不同币种不能加在一起） */
  signedAmount: number;
  /** 已签约按币种合计（2026-10-03）。老调用方没给就当没有 */
  signedTotals?: { 币种: string; 合计: number }[];
  /** 在公海里（2026-10-03 第 6 块）。老调用方没给就当不在 */
  pool?: { reason: string } | null;
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
  const 我 = useMe();
  const [saving, setSaving] = useState(false);
  const [dup, setDup] = useState<DuplicateHit | null>(null);
  /** 保存时发现别人已经改过这条记录 */
  const [conflict, setConflict] = useState<SaveConflict | null>(null);
  // 先看推荐人再看渠道：转介绍的人 channelId 也有值（排查 A1，见 lib/referrer-kind.ts）
  const [referrerType, setReferrerType] = useState<"channel" | "customer" | "none">(推荐方式(editing));
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
  /** 新建必填；编辑时只有原来就有号码的才必填（和 saveCustomer 同一条，见 lib/phone.ts） */
  const 电话必填 = !editing || Boolean(editing.phone);
  const 负责人选项 = 成员选项(users);
  if (editing && !users.some((u) => u.id === editing.salesOwnerId)) {
    负责人选项.push({ value: editing.salesOwnerId, label: `${editing.salesOwnerName}（已不再担任负责人）` });
  }

  /** 就地新建渠道的子弹窗 */
  const [channelModal, setChannelModal] = useState(false);
  /** 渠道下拉的开合。受控是因为点「新建」时必须先收起它——它的层级在子弹窗之上，不收会挡住表单 */
  const [channelOpen, setChannelOpen] = useState(false);

  /** 手机号失焦时查重，避免同一个人被重复录入 */
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
              channelOwnerId: editing.channelOwnerId,
            }
          : null,
        name: v.name,
        phone: v.phone ?? "",
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
        /*
          新建不传（按推荐链算）。编辑时**只有人动过这一格才传**：选了就钉死，清空就 null（恢复按推荐链）。
          原来每次都传——这一格的初值就是现在的渠道负责人，于是换了推荐渠道，负责人还被当成「手工指定」钉在旧的人身上（排查 A4）
        */
        ...(editing && form.isFieldTouched("channelOwnerId") ? { channelOwnerId: v.channelOwnerId ?? null } : {}),
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
      // 换了负责人时，原负责人没做完的活一起转了过去，说一声（排查 B3）
      const 带走 = 带走说法(res.带走);
      message.success(editing ? (带走 ? `已保存${带走}一起转给了新负责人` : "已保存") : `${b.customer}已创建`);
      onClose(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <Modal
      afterOpenChange={聚焦首项}
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
            : { followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 默认负责人(我, users) }
        }
      >
        {conflict && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            // 不说「有人」「对方」：桌面端一个人开两个窗口也会撞上（2026-10-02 按桌面端 / 网页端复核）
            title="这一项在你编辑期间也被改过，你的改动没有保存"
            description={
              <>
                <div>
                  这条记录在 {dayjs(conflict.currentUpdatedAt).format("MM-DD HH:mm:ss")} 又被改过，
                  两边都动了：<b>{conflict.fields.join("、")}</b>。
                  {conflict.theirFields.length > conflict.fields.length && (
                    <> 那一次另外还改了：{conflict.theirFields
                      .filter((f) => !conflict.fields.includes(f))
                      .join("、")}。</>
                  )}
                </div>
                <div style={{ marginTop: 8 }}>
                  两次改到同一项，系统不替你决定留哪一个。请关闭后刷新，
                  看清现在是什么，再决定要不要改回来。
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
            // 撞的是客户表（checkDuplicate 只查 customer），照实说、用工作区的叫法。
            // 原来写「系统中已有这条线索」，团队里撞号常见，人会去线索页找（2026-10-04 J-038）
            title={`已有${b.customer}用这个号码`}
            description={
              dup.name ? (
                <span>
                  {dup.name}
                  {dup.school ? ` · ${dup.school}` : ""} · 销售负责人 {dup.salesOwnerName} · 录入于{" "}
                  {dayjs(dup.createdAt).format("YYYY-MM-DD")}
                </span>
              ) : (
                // 业务员撞到同事名下、自己看不到的：只说是谁在跟，不露是哪位（10-04 拍板）
                <span>
                  同事 {dup.salesOwnerName} 名下已经有这个号码，请勿重复录入；要接手请找 {dup.salesOwnerName} 或老板
                </span>
              )
            }
          />
        )}

        <Row gutter={16}>
          <Col span={8}>
            {/* 跟业务配置的叫法走（2026-10-04 L-003）：改成「学员」后这里原来还写着「客户姓名」 */}
            <Form.Item label={`${b.customer}姓名`} name="name" rules={[{ required: true, message: "请输入姓名" }]}>
              <Input placeholder="如：张三" />
            </Form.Item>
          </Col>
          <Col span={8}>
            {/* 和导入、服务端同一条规矩（lib/phone.ts）：收海外号和座机；
                只有新建、或原来就有号码的才必填——原来没电话的人改个备注不该被它卡住 */}
            <Form.Item
              label="联系电话"
              name="phone"
              required={电话必填}
              rules={[
                {
                  validator: (_, v: string | undefined) => {
                    // 共享试用区里号码是打了码给人看的：没动它就放行，服务端会认回原号（排查 A2）
                    if (editing && v && v.includes("*") && v === editing.phone) return Promise.resolve();
                    const r = 查电话(v, { 必填: 电话必填 });
                    return r.ok ? Promise.resolve() : Promise.reject(new Error(r.error));
                  },
                },
              ]}
            >
              <Input placeholder={电话必填 ? "13800001111" : "没有可以先空着"} onBlur={onPhoneBlur} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label={b.fields.school} name="school">
              <Input placeholder={字段是公司(b.fields.school) ? "如：星辰科技" : undefined} />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label={b.fields.major} name="major">
              {/* 叫「行业」（或「所属行业」这类，2026-10-04 L-016 同一个认法）时给候选，也能直接填；教培的「专业」千变万化，照旧手填 */}
              {字段是行业(b.fields.major) ? <OptionInput options={b.industries} placeholder="选一个，或直接填" /> : <Input />}
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label={b.fields.grade} name="grade">
              {/*
                能选也能填。库里这一列是自由文本，那张下拉表只是建议——
                人手上的职位千奇百怪（结构工程师、班主任、采购总监），
                封死下拉的结果是他根本录不进来，只能空着。
                跟进状态 / 决策状态不这么做：那两个被盯盘和报表吃着，必须封闭。
              */}
              <AutoComplete
                allowClear
                placeholder="选一个，或直接填"
                options={b.grades.map((g) => ({ value: g }))}
                filterOption={(输入, o) => String(o?.value ?? "").toLowerCase().includes(输入.toLowerCase())}
              />
            </Form.Item>
          </Col>
          {/* 只有一个人时不问归属，见 lib/utils.ts 的 独自一人 */}
          {!独自一人(users, editing?.salesOwnerId) && (
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
          )}
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

        {/* 渠道负责人：默认跟着推荐链算；只有登记错误才需要在这里单独指定，
            指定后不再随渠道变动，也不影响任何其他学员 */}
        {/* 一个人用时不摆：推荐链和手选都只能是自己（2026-10-02 按桌面端复核） */}
        {editing && !独自一人(users, editing.channelOwnerId) && (
          <Form.Item
            name="channelOwnerId"
            label="渠道负责人"
            style={{ marginBottom: 12 }}
            extra="留空则按推荐链自动确定。只改这一位，不影响同渠道的其他人"
          >
            <Select allowClear placeholder={editing.channelOwnerName ? `${editing.channelOwnerName}（按推荐链）` : "按推荐链自动确定"} options={成员选项(users)} />
          </Form.Item>
        )}
        {referrerType !== "none" && (
          <Typography.Text type="secondary" style={{ display: "block", marginBottom: 16, fontSize: 13 }}>
            渠道归属由系统按推荐链自动计算，保存后可在详情页查看
          </Typography.Text>
        )}

        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label="跟进状态" name="followStatus" rules={[{ required: true }]}>
              <Select options={FOLLOW_STATUSES.map((s) => ({ value: s, label: statusLabel(b, s) }))} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label={`${b.customer}决策状态`} name="decisionStatus" rules={[{ required: true }]}>
              <Select options={DECISION_STATUSES.map((s) => ({ value: s, label: statusLabel(b, s) }))} />
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
      afterOpenChange={聚焦首项}
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
        {/* 一个人用时不问：不传，服务端填成那唯一的人（saveChannel 的 唯一负责人） */}
        {!独自一人(users) && (
          <Form.Item
            label="渠道负责人"
            name="channelOwnerId"
            rules={[{ required: true, message: "请选择渠道负责人" }]}
            extra={`该渠道带来的${b.customer}及其下游转介绍，渠道负责人都归此人`}
          >
            <Select placeholder="请选择" options={成员选项(users)} />
          </Form.Item>
        )}
        <Form.Item label="备注" name="remark">
          <Input.TextArea rows={2} placeholder="选填" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
