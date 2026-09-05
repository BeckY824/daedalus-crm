"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Card,
  Table,
  Input,
  Button,
  Space,
  Select,
  Tag,
  Modal,
  Form,
  Row,
  Col,
  App,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  SearchOutlined,
  ShareAltOutlined,
  PlusOutlined,
  SwapRightOutlined,
  DeleteOutlined,
  EditOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { PageHead } from "@/components/ui";
import { LEAD_STATUSES, LEAD_STATUS_COLOR } from "@/lib/constants";
import { fmtDate, 成员选项, 可选成员 } from "@/lib/utils";
import { saveLead, deleteLeads, convertLead } from "./actions";
import { useBusiness } from "@/lib/business-client";

type Row = {
  id: string;
  name: string;
  contact: string | null;
  phone: string | null;
  email: string | null;
  industry: string | null;
  source: string;
  status: string;
  remark: string | null;
  ownerId: string | null;
  ownerName: string;
  customerId: string | null;
  createdAt: string;
};

export default function LeadsView({
  rows,
  users,
  filters,
  me,
}: {
  rows: Row[];
  users: 可选成员[];
  filters: { keyword: string; status: string };
  me: string;
}) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const b = useBusiness();
  const [pending, startTransition] = useTransition();
  const [f, setF] = useState(filters);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    if (!open) return;
    if (editing) form.setFieldsValue(editing);
    else {
      form.resetFields();
      form.setFieldsValue({ source: "官网注册", status: "待跟进", ownerId: me });
    }
  }, [open, editing, form, me]);

  function apply(next: Partial<typeof f> = {}) {
    const merged = { ...f, ...next };
    setF(merged);
    const q = new URLSearchParams();
    Object.entries(merged).forEach(([k, v]) => v && q.set(k, String(v)));
    startTransition(() => router.push(`/leads?${q}`));
  }

  async function onOk() {
    const v = await form.validateFields();
    const res = await saveLead({ id: editing?.id, ...v });
    if (!res.ok) {
      message.error(res.error);
      return;
    }
    message.success(editing ? "已保存" : "线索已创建");
    setOpen(false);
    router.refresh();
  }

  const columns: ColumnsType<Row> = [
    { title: "线索名称", dataIndex: "name", width: 274, render: (v) => <span className="link-strong">{v}</span> },
    { title: "联系人", dataIndex: "contact", width: 118, render: (v) => v ?? "—" },
    { title: "联系电话", dataIndex: "phone", width: 152, render: (v) => v ?? "—" },
    { title: "所属行业", dataIndex: "industry", width: 130, render: (v) => <span className="muted">{v ?? "—"}</span> },
    { title: "线索来源", dataIndex: "source", width: 130, render: (v) => <Tag style={{ margin: 0, borderRadius: 6 }}>{v}</Tag> },
    {
      title: "状态",
      dataIndex: "status",
      width: 114,
      render: (v) => (
        <Tag color={LEAD_STATUS_COLOR[v] ?? "default"} style={{ margin: 0, borderRadius: 6 }}>
          {v}
        </Tag>
      ),
    },
    { title: "负责人", dataIndex: "ownerName", width: 114 },
    { title: "创建时间", dataIndex: "createdAt", width: 138, render: (v) => fmtDate(v) },
    {
      title: "",
      key: "act",
      width: 178,
      fixed: "right",
      render: (_, r) =>
        r.customerId ? (
          <Link href={`/customers/${r.customerId}`}>查看客户 ›</Link>
        ) : (
          <Space size={2}>
            <Button
              type="link"
              size="small"
              icon={<SwapRightOutlined />}
              onClick={() =>
                modal.confirm({
                  title: `将「${r.name}」转为客户？`,
                  content: "会自动创建客户记录与联系人，线索标记为已转化。",
                  okText: "转为客户",
                  cancelText: "取消",
                  async onOk() {
                    const res = await convertLead(r.id);
                    if (res.ok) {
                      message.success("已转为客户");
                      router.push(`/customers/${res.customerId}`);
                    } else message.error(res.error);
                  },
                })
              }
            >
              转客户
            </Button>
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => {
                setEditing(r);
                setOpen(true);
              }}
            />
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() =>
                modal.confirm({
                  title: `删除线索「${r.name}」？`,
                  okText: "删除",
                  okButtonProps: { danger: true },
                  cancelText: "取消",
                  async onOk() {
                    const res = await deleteLeads([r.id]);
                    // 行可能已被别人删掉，如实说，别一律提示「已删除」
                    message.success(res.deleted ? "已删除" : "该线索已不存在，可能已被其他人删除");
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
        title="线索管理"
        subtitle="全渠道线索统一汇聚"
        tag="线索管理"
        tagNote="从线索到客户，转化路径清晰可控"
      />
      <Card styles={{ body: { padding: 22 } }}>
        <Space style={{ marginBottom: 14 }} wrap>
          <Select
            style={{ width: 152 }}
            placeholder="全部状态"
            allowClear
            value={f.status || undefined}
            onChange={(v) => apply({ status: v ?? "" })}
            options={LEAD_STATUSES.map((s) => ({ value: s, label: s }))}
          />
          <Input
            style={{ width: 280 }}
            placeholder="线索名称 / 联系人"
            prefix={<SearchOutlined style={{ color: "#94a3b8" }} />}
            value={f.keyword}
            allowClear
            onChange={(e) => setF({ ...f, keyword: e.target.value })}
            onPressEnter={() => apply()}
          />
          <Button type="primary" onClick={() => apply()} loading={pending}>搜索</Button>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              setF({ keyword: "", status: "" });
              startTransition(() => router.push("/leads"));
            }}
          >
            重置
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            新建线索
          </Button>
        </Space>

        <Table<Row>
          rowKey="id"
          size="middle"
          dataSource={rows}
          columns={columns}
          loading={pending}
          scroll={{ x: 1370 }}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条`, showSizeChanger: true }}
        />
      </Card>

      <Modal
        open={open}
        title={editing ? "编辑线索" : "新建线索"}
        onCancel={() => setOpen(false)}
        onOk={onOk}
        okText="保存"
        cancelText="取消"
        width={600}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item name="name" label="线索名称" rules={[{ required: true, message: "请填写线索名称" }]}>
                <Input placeholder="公司名称或线索标题" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="contact" label="联系人"><Input placeholder="王妈妈" /></Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="phone" label="联系电话"><Input placeholder="13800002211" /></Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="email" label="邮箱"><Input /></Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="industry" label="所属行业">
                <Select allowClear showSearch options={b.industries.map((i) => ({ value: i, label: i }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="source" label="线索来源">
                <Select options={b.sources.map((i) => ({ value: i, label: i }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="status" label="状态">
                <Select options={LEAD_STATUSES.filter((s) => s !== "已转化").map((i) => ({ value: i, label: i }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="ownerId" label="负责人">
                <Select options={成员选项(users)} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="remark" label="备注">
                <Input.TextArea rows={2} placeholder="线索来源细节、初步需求…" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
}
