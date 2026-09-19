"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Space, Tag, Modal, Form, Input, Select, App, Tooltip } from "antd";
import { PlusOutlined, EditOutlined, DeleteOutlined, StopOutlined, CheckCircleOutlined, SearchOutlined, ReloadOutlined } from "@ant-design/icons";
import { PageHead, UserCell } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
import { money, fmtDate, 成员选项, 独自一人, 可选成员 } from "@/lib/utils";
import { saveChannel, toggleChannel, deleteChannel } from "./actions";
import ReferralRadar from "./ReferralRadar";
import type { TopReferrer, InviteCandidate } from "@/lib/referral";
import { useBusiness } from "@/lib/business-client";

type Row = {
  id: string;
  name: string;
  phone: string | null;
  remark: string | null;
  active: boolean;
  createdAt: string;
  channelOwnerId: string;
  channelOwnerName: string;
  /** 该渠道直接推荐的学员数 */
  directCount: number;
  /** 整条推荐链上的学员数（含转介绍的下游） */
  chainCount: number;
  chainAmount: number;
};

export default function ChannelsView({
  rows: 全部行,
  users,
  radar,
  aiEnabled,
}: {
  rows: Row[];
  users: 可选成员[];
  radar: { topReferrers: TopReferrer[]; inviteCandidates: InviteCandidate[] };
  aiEnabled: boolean;
}) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const b = useBusiness();
  /* 三个筛选条件都在本地：行已经全在手上了 */
  const [kw, setKw] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [active, setActive] = useState("");
  const rows = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return 全部行.filter(
      (r) =>
        (!k || r.name.toLowerCase().includes(k) || (r.phone ?? "").includes(k) || (r.remark ?? "").toLowerCase().includes(k)) &&
        (!ownerId || r.channelOwnerId === ownerId) &&
        (!active || (active === "on") === r.active),
    );
  }, [全部行, kw, ownerId, active]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  function openForm(r: Row | null) {
    setEditing(r);
    setOpen(true);
  }

  async function onOk() {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const res = await saveChannel({ id: editing?.id, ...v });
      if (!res.ok) return message.error(res.error);
      message.success(editing ? "已保存" : "渠道已创建");
      setOpen(false);
      setEditing(null);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const 列表: 列<Row>[] = [
    { title: "渠道", key: "name", dataIndex: "name", width: 180, 常驻: true, render: (v) => <span className="link-strong">{v}</span> },
    { title: "渠道负责人", key: "channelOwnerName", dataIndex: "channelOwnerName", width: 140, render: (v) => <UserCell name={v} size={24} /> },
    {
      title: "直接推荐", key: "directCount", dataIndex: "directCount", width: 110,
      sorter: (a, b2) => a.directCount - b2.directCount,
      render: (v: number, r) => (
        <Tooltip title={`这条渠道亲自带来的${b.customer}，不含他们再转介绍来的`}>
          {v > 0 ? <Link href={`/customers?keyword=${encodeURIComponent(r.name)}`}>{v} 人</Link> : <span className="muted">0</span>}
        </Tooltip>
      ),
    },
    {
      /*
        这两列到 2026-09-19 为止永远相等：「直接」取的是 `_count.directCustomers`，
        而那个关系走 `Customer.channelId`——按 schema 的定义它是**链条最顶端的渠道、
        所有后代继承**，数的本来就是整条链。两列并排摆着、一列还写着「含下游转介绍」，
        却是同一个谓词算了两遍。转介绍到底带来了多少人，这张表一直答不出来。
        现在「直接」只数没有上游学员的那些，差额就是转介绍的部分。
      */
      title: "整条推荐链", key: "chainCount", dataIndex: "chainCount", width: 120,
      sorter: (a, b2) => a.chainCount - b2.chainCount,
      render: (v: number, r) => (
        <Tooltip title={`含下游转介绍带来的全部${b.customer}；其中 ${r.directCount} 位是这条渠道直接带来的`}>
          <span>
            {v} 人
            {v > r.directCount && <span className="muted">（转介绍 {v - r.directCount}）</span>}
          </span>
        </Tooltip>
      ),
    },
    {
      title: "链上签约额", key: "chainAmount", dataIndex: "chainAmount", width: 130,
      sorter: (a, b2) => a.chainAmount - b2.chainAmount,
      render: (v: number) => (v > 0 ? <span style={{ fontWeight: 500 }}>{money(v)}</span> : <span className="muted">—</span>),
    },
    {
      // 状态三样齐全：颜色、图标、文字。只靠一个灰标签，扫过去认不出哪条停用了
      title: "状态", key: "active", dataIndex: "active", width: 100,
      render: (v: boolean) =>
        v ? (
          <Tag color="success" style={{ margin: 0, borderRadius: 6 }}>
            <CheckCircleOutlined /> 启用
          </Tag>
        ) : (
          <Tag style={{ margin: 0, borderRadius: 6 }}>
            <StopOutlined /> 已停用
          </Tag>
        ),
    },

    { title: "联系电话", key: "phone", dataIndex: "phone", width: 140, 默认: false, render: (v) => v ?? <span className="muted">—</span> },
    { title: "备注", key: "remark", dataIndex: "remark", width: 200, 默认: false, render: (v) => v ?? <span className="muted">—</span> },
    { title: "创建时间", key: "createdAt", dataIndex: "createdAt", width: 116, 默认: false, render: (v) => <span className="muted nowrap">{fmtDate(v)}</span> },
    {
      title: "", key: "act", width: 110, 常驻: true, fixed: "right",
      render: (_, r) => (
        <Space size={2}>
          <Button aria-label={`编辑 ${r.name}`} title="编辑" type="text" size="small" icon={<EditOutlined />} onClick={() => openForm(r)} />
          <Tooltip title={r.active ? "停用" : "恢复"}>
            <Button
              aria-label={`${r.active ? "停用" : "恢复"} ${r.name}`}
              type="text"
              size="small"
              icon={r.active ? <StopOutlined /> : <CheckCircleOutlined />}
              onClick={async () => {
                await toggleChannel(r.id, !r.active);
                message.success(r.active ? "已停用" : "已恢复");
                router.refresh();
              }}
            />
          </Tooltip>
          <Button
            aria-label={`删除 ${r.name}`}
            title="删除"
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() =>
              modal.confirm({
                title: `删除渠道「${r.name}」？`,
                okText: "删除",
                okButtonProps: { danger: true },
                cancelText: "取消",
                async onOk() {
                  const res = await deleteChannel(r.id);
                  if (!res.ok) return message.error(res.error);
                  message.success("已删除");
                  router.refresh();
                },
              })
            }
          />
        </Space>
      ),
    },
  ];

  return (
    <>
      <PageHead
        title="渠道"
        subtitle="外部推荐来源与转介绍"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm(null)}>
            新建渠道
          </Button>
        }
      />

      <DataList<Row>
        页="channels"
        空库={全部行.length === 0}
        列={列表}
        行={rows}
        空态={{
          title: "还没有渠道",
          hint: `渠道是${b.customer}从哪来的：合作老师、中介、家长社群。渠道负责人定了之后，这条线上进来的${b.customer}业绩自动归他；转介绍带来的下游也算在这条链上。`,
          primary: { label: "新建第一个渠道", onClick: () => openForm(null) },
        }}
        筛选={
          /* 渠道页一次就把行全拿下来了（没有服务端分页），所以筛在本地做：
             不用为三个下拉多跑一趟服务端，改完立刻见效 */
          <Space wrap size={[10, 10]}>
            <Input
              style={{ width: 240 }}
              placeholder="搜索渠道"
              prefix={<SearchOutlined style={{ color: "var(--text-muted)" }} />}
              value={kw}
              allowClear
              onChange={(e) => setKw(e.target.value)}
            />
            <Select
              style={{ width: 150 }}
              placeholder="全部负责人"
              allowClear
              value={ownerId || undefined}
              onChange={(v) => setOwnerId(v ?? "")}
              options={成员选项(users)}
            />
            <Select
              style={{ width: 130 }}
              placeholder="全部状态"
              allowClear
              value={active || undefined}
              onChange={(v) => setActive(v ?? "")}
              options={[{ value: "on", label: "合作中" }, { value: "off", label: "已停用" }]}
            />
            {(kw || ownerId || active) && (
              <Button icon={<ReloadOutlined />} onClick={() => { setKw(""); setOwnerId(""); setActive(""); }}>
                重置
              </Button>
            )}
          </Space>
        }
      />

      {/* 雷达在两栏都空时不出现，页面不该有一块常驻的空卡片 */}
      {(radar.topReferrers.length > 0 || radar.inviteCandidates.length > 0) && (
        <ReferralRadar topReferrers={radar.topReferrers} inviteCandidates={radar.inviteCandidates} aiEnabled={aiEnabled} />
      )}

      {open && (
        <Modal
          open
          title={editing ? "编辑渠道" : "新建渠道"}
          onCancel={() => { setOpen(false); setEditing(null); }}
          onOk={onOk}
          confirmLoading={saving}
          okText="保存"
          cancelText="取消"
          destroyOnHidden
        >
          <Form
            form={form}
            layout="vertical"
            style={{ marginTop: 8 }}
            initialValues={editing ?? {}}
          >
            <Form.Item label="渠道姓名" name="name" rules={[{ required: true, message: "请输入渠道姓名" }]}>
              <Input placeholder="如：小红" />
            </Form.Item>
            <Form.Item label="联系电话" name="phone">
              <Input placeholder="13700001111" />
            </Form.Item>
            {/*
              **只有一个人时不问这一项**（2026-09-18）。桌面端是一人公司、或者一个销售
              自己记账，库里就他一个人——让他从一个只有自己的下拉里选一次自己，
              是在问一个只有一个答案的问题，而且它还是必填的。留空交给服务端填
              （actions.ts 的 唯一负责人）。编辑一条挂在别人名下的旧记录时照样问。
            */}
            {!独自一人(users, editing?.channelOwnerId) && (
              <Form.Item
                label="渠道负责人"
                name="channelOwnerId"
                rules={[{ required: true, message: "请选择渠道负责人" }]}
                extra={`之后由该渠道新增的${b.customer}及其下游转介绍归此人；已有${b.customer}的归属不变，个别要改的到其档案里单独改`}
              >
                <Select placeholder="请选择" options={成员选项(users)} />
              </Form.Item>
            )}
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} placeholder="渠道背景、合作方式…" />
            </Form.Item>
          </Form>
        </Modal>
      )}
    </>
  );
}
