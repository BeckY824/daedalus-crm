"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Input, Button, Space, Select, Tag, Modal, Form, Row, Col, App } from "antd";
import {
  SearchOutlined,
  PlusOutlined,
  SwapRightOutlined,
  DeleteOutlined,
  EditOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { PageHead, UserCell } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
import { LEAD_STATUSES, LEAD_STATUS_COLOR } from "@/lib/constants";
import { 成员选项, 独自一人, 可选成员, smartTime } from "@/lib/utils";
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
  /** 空库 = 一条都没有**且**没在筛。筛出 0 条时筛选栏要留着，见 DataList */
  const 空库 = rows.length === 0 && !Object.values(filters).some((v) => v);
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

  const 列表: 列<Row>[] = [
    { title: "线索", key: "name", dataIndex: "name", width: 220, 常驻: true, render: (v) => <span className="link-strong">{v}</span> },
    { title: "联系人", key: "contact", dataIndex: "contact", width: 120, render: (v) => v ?? <span className="muted">—</span> },
    { title: "来源", key: "source", dataIndex: "source", width: 120, render: (v) => <Tag style={{ margin: 0, borderRadius: 6 }}>{v}</Tag> },
    {
      title: "状态", key: "status", dataIndex: "status", width: 110,
      render: (v) => (
        <Tag color={LEAD_STATUS_COLOR[v] ?? "default"} style={{ margin: 0, borderRadius: 6 }}>
          {v}
        </Tag>
      ),
    },
    { title: "负责人", key: "ownerName", dataIndex: "ownerName", width: 140, render: (v) => <UserCell name={v} size={24} /> },
    { title: "创建时间", key: "createdAt", dataIndex: "createdAt", width: 116, render: (v) => <span className="muted nowrap">{smartTime(v)}</span> },

    { title: "联系电话", key: "phone", dataIndex: "phone", width: 140, 默认: false, render: (v) => v ?? <span className="muted">—</span> },
    { title: "所属行业", key: "industry", dataIndex: "industry", width: 130, 默认: false, render: (v) => <span className="muted">{v ?? "—"}</span> },
    { title: "邮箱", key: "email", dataIndex: "email", width: 200, 默认: false, render: (v) => v ?? <span className="muted">—</span> },
    {
      title: "", key: "act", width: 150, 常驻: true, fixed: "right",
      render: (_, r) =>
        r.customerId ? (
          <Link href={`/customers/${r.customerId}`}>查看{b.customer} ›</Link>
        ) : (
          <Space size={2}>
            <Button
              type="link"
              size="small"
              icon={<SwapRightOutlined />}
              onClick={() =>
                modal.confirm({
                  title: `将「${r.name}」转为${b.customer}？`,
                  content: `会自动创建${b.customer}记录与联系人，线索标记为已转化。`,
                  okText: `转为${b.customer}`,
                  cancelText: "取消",
                  async onOk() {
                    const res = await convertLead(r.id);
                    if (res.ok) {
                      message.success(`已转为${b.customer}`);
                      router.push(`/customers/${res.customerId}`);
                    } else message.error(res.error);
                  },
                })
              }
            >
              转{b.customer}
            </Button>
            <Button
              aria-label={`编辑 ${r.name}`}
              title="编辑"
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => {
                setEditing(r);
                setOpen(true);
              }}
            />
            <Button
              aria-label={`删除 ${r.name}`}
              title="删除"
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
        title="线索"
        subtitle="还没建档的线索"
        extra={
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
        }
      />

      <DataList<Row>
        页="leads"
        空库={空库}
        列={列表}
        行={rows}
        加载中={pending}
        空态={{
          title: "还没有线索",
          hint: `线索是还没确认要不要跟的人。确认要跟了就转成${b.customer}，之后的跟进、商机、签约都在${b.customer}那边走。`,
          primary: { label: "新建第一条线索", onClick: () => { setEditing(null); setOpen(true); } },
        }}
        筛选={
          <Space wrap size={[10, 10]}>
            <Input
              style={{ width: 280 }}
              placeholder="线索名称 / 联系人"
              prefix={<SearchOutlined style={{ color: "var(--text-muted)" }} />}
              value={f.keyword}
              allowClear
              onChange={(e) => {
                const v = e.target.value;
                setF({ ...f, keyword: v });
                // 点了清空的小叉：立刻生效，不用人再回车一次
                if (!v) apply({ keyword: "" });
              }}
              onPressEnter={() => apply()}
            />
            <Select
              style={{ width: 152 }}
              placeholder="全部状态"
              allowClear
              value={f.status || undefined}
              onChange={(v) => apply({ status: v ?? "" })}
              options={LEAD_STATUSES.map((s2) => ({ value: s2, label: s2 }))}
            />
            {(f.keyword || f.status) && (
              <Button
                icon={<ReloadOutlined />}
                onClick={() => {
                  setF({ keyword: "", status: "" });
                  startTransition(() => router.push("/leads"));
                }}
              >
                重置
              </Button>
            )}
          </Space>
        }
      />

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
            {/* 只有一个人时不问归属，见 lib/utils.ts 的 独自一人 */}
            {!独自一人(users, editing?.ownerId) && (
              <Col span={8}>
                <Form.Item name="ownerId" label="负责人">
                  <Select options={成员选项(users)} />
                </Form.Item>
              </Col>
            )}
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
