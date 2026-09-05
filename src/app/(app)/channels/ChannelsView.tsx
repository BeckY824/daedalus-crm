"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, Table, Button, Space, Tag, Modal, Form, Input, Select, App, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined, ShareAltOutlined, StopOutlined, CheckCircleOutlined } from "@ant-design/icons";
import { PageHead, UserCell } from "@/components/ui";
import { money, fmtDate, 成员选项, 可选成员 } from "@/lib/utils";
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
  rows,
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

  const columns: ColumnsType<Row> = [
    {
      title: "渠道姓名",
      dataIndex: "name",
      width: 160,
      render: (v, r) => (
        <Space size={8}>
          <span className="link-strong">{v}</span>
          {!r.active && <Tag style={{ margin: 0, borderRadius: 6 }}>已停用</Tag>}
        </Space>
      ),
    },
    { title: "联系电话", dataIndex: "phone", width: 150, render: (v) => v ?? <span className="muted">—</span> },
    {
      title: "渠道负责人",
      dataIndex: "channelOwnerName",
      width: 140,
      render: (v) => <UserCell name={v} size={30} />,
    },
    {
      title: "直接推荐",
      dataIndex: "directCount",
      width: 110,
      sorter: (a, b) => a.directCount - b.directCount,
      render: (v: number, r) =>
        v > 0 ? <Link href={`/customers?keyword=${encodeURIComponent(r.name)}`}>{v} 人</Link> : <span className="muted">0</span>,
    },
    {
      title: "整条推荐链",
      dataIndex: "chainCount",
      width: 130,
      sorter: (a, b) => a.chainCount - b.chainCount,
      render: (v: number) => (
        <Tooltip title={`含下游转介绍带来的全部${b.customer}`}>
          <span>{v} 人</span>
        </Tooltip>
      ),
    },
    {
      title: "链上签约额",
      dataIndex: "chainAmount",
      width: 140,
      sorter: (a, b) => a.chainAmount - b.chainAmount,
      render: (v: number) => (v > 0 ? <span style={{ fontWeight: 500 }}>{money(v)}</span> : <span className="muted">—</span>),
    },
    { title: "备注", dataIndex: "remark", render: (v) => v ?? <span className="muted">—</span> },
    { title: "创建时间", dataIndex: "createdAt", width: 130, render: (v) => <span className="muted nowrap">{fmtDate(v)}</span> },
    {
      title: "",
      key: "act",
      width: 130,
      fixed: "right",
      render: (_, r) => (
        <Space size={2}>
          <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openForm(r)} />
          <Tooltip title={r.active ? "停用" : "恢复"}>
            <Button
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
        icon={<ShareAltOutlined />}
        title="渠道管理"
        subtitle="外部推荐来源，整条推荐链的起点"
        tag="渠道管理"
        tagNote="维护外部渠道及其负责人，业绩自动归集"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm(null)}>
            新建渠道
          </Button>
        }
      />

      <Card styles={{ body: { padding: 22 } }}>
        <Table<Row>
          rowKey="id"
          size="middle"
          dataSource={rows}
          columns={columns}
          scroll={{ x: 1400 }}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
        />
      </Card>

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
            <Form.Item
              label="渠道负责人"
              name="channelOwnerId"
              rules={[{ required: true, message: "请选择渠道负责人" }]}
              extra={`该渠道带来的${b.customer}及其下游转介绍，渠道负责人都归此人`}
            >
              <Select placeholder="请选择" options={成员选项(users)} />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} placeholder="渠道背景、合作方式…" />
            </Form.Item>
          </Form>
        </Modal>
      )}
    </>
  );
}
