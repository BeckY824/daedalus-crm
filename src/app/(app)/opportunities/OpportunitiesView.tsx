"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
  InputNumber,
  DatePicker,
  Slider,
  App,
  Statistic,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  SearchOutlined,
  DollarOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ReloadOutlined,
  PartitionOutlined,
} from "@ant-design/icons";
import { PageHead, CustomerLink, UserCell } from "@/components/ui";
import { OPP_STAGES, STAGE_PROBABILITY } from "@/lib/constants";
import { money, fmtDate, dayjs, 成员选项, 可选成员 } from "@/lib/utils";
import { saveOpportunity, deleteOpportunities, moveStage, setOppStatus } from "./actions";

export type OppRow = {
  id: string;
  name: string;
  amount: number;
  stage: string;
  status: string;
  probability: number;
  expectedDealAt: string | null;
  remark: string | null;
  customerId: string;
  customerName: string;
  ownerId: string;
  ownerName: string;
};

export default function OpportunitiesView({
  rows,
  users,
  customers,
  filters,
}: {
  rows: OppRow[];
  users: 可选成员[];
  customers: { id: string; name: string }[];
  filters: { keyword: string; stage: string; status: string; ownerId: string };
}) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [f, setF] = useState(filters);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<OppRow | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue({
        ...editing,
        expectedDealAt: editing.expectedDealAt ? dayjs(editing.expectedDealAt) : null,
      });
    } else {
      form.resetFields();
      form.setFieldsValue({
        stage: "初步沟通",
        status: "OPEN",
        probability: 20,
        amount: 100000,
        ownerId: users[0]?.id,
      });
    }
  }, [open, editing, form, users]);

  function apply(next: Partial<typeof f> = {}) {
    const merged = { ...f, ...next };
    setF(merged);
    const q = new URLSearchParams();
    Object.entries(merged).forEach(([k, v]) => v && q.set(k, String(v)));
    startTransition(() => router.push(`/opportunities?${q}`));
  }

  async function onOk() {
    const v = await form.validateFields();
    const res = await saveOpportunity({
      id: editing?.id,
      ...v,
      expectedDealAt: v.expectedDealAt ? v.expectedDealAt.toISOString() : null,
    });
    if (!res.ok) {
      message.error(res.error);
      return;
    }
    message.success(editing ? "已保存" : "商机已创建");
    setOpen(false);
    router.refresh();
  }

  const totalAmount = rows.reduce((s, r) => s + r.amount, 0);
  const openAmount = rows.filter((r) => r.status === "OPEN").reduce((s, r) => s + r.amount, 0);
  const forecast = rows
    .filter((r) => r.status === "OPEN")
    .reduce((s, r) => s + r.amount * (r.probability / 100), 0);

  const columns: ColumnsType<OppRow> = [
    { title: "商机名称", dataIndex: "name", width: 262, fixed: "left", render: (v) => <span className="link-strong">{v}</span> },
    {
      title: "所属客户",
      dataIndex: "customerName",
      width: 274,
      render: (v, r) => <CustomerLink id={r.customerId} name={v} />,
    },
    {
      title: "金额",
      dataIndex: "amount",
      width: 154,
      sorter: (a, b) => a.amount - b.amount,
      render: (v) => <span style={{ fontWeight: 600 }}>{money(v)}</span>,
    },
    {
      title: "阶段",
      dataIndex: "stage",
      width: 156,
      render: (v, r) => (
        <Select
          size="small"
          value={v}
          variant="borderless"
          style={{ width: 140 }}
          disabled={r.status !== "OPEN"}
          options={OPP_STAGES.map((s) => ({ value: s, label: s }))}
          onChange={async (s) => {
            const res = await moveStage(r.id, s);
            if (!res.ok) {
              message.error(res.error);
              router.refresh();
              return;
            }
            message.success(`已推进到「${s}」`);
            router.refresh();
          }}
        />
      ),
    },
    { title: "概率", dataIndex: "probability", width: 88, render: (v) => `${v}%` },
    { title: "预计成交", dataIndex: "expectedDealAt", width: 138, render: (v) => fmtDate(v) },
    { title: "负责人", dataIndex: "ownerName", width: 128, render: (v) => <UserCell name={v} size={30} /> },
    {
      title: "状态",
      dataIndex: "status",
      width: 114,
      render: (v) => (
        <Tag color={v === "WON" ? "success" : v === "LOST" ? "error" : "processing"} style={{ margin: 0, borderRadius: 6 }}>
          {v === "WON" ? "已赢单" : v === "LOST" ? "已丢单" : "进行中"}
        </Tag>
      ),
    },
    {
      title: "",
      key: "act",
      width: 208,
      fixed: "right",
      render: (_, r) => (
        <Space size={2}>
          {r.status === "OPEN" && (
            <>
              <Button
                type="link"
                size="small"
                onClick={async () => {
                  await setOppStatus(r.id, "WON");
                  message.success("恭喜赢单！");
                  router.refresh();
                }}
              >
                赢单
              </Button>
              <Button
                type="link"
                size="small"
                danger
                onClick={async () => {
                  await setOppStatus(r.id, "LOST");
                  router.refresh();
                }}
              >
                丢单
              </Button>
            </>
          )}
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
                title: `删除商机「${r.name}」？`,
                okText: "删除",
                okButtonProps: { danger: true },
                cancelText: "取消",
                async onOk() {
                  await deleteOpportunities([r.id]);
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
        icon={<DollarOutlined />}
        title="商机管理"
        subtitle="数据驱动成交，管道一目了然"
        tag="商机管理"
        tagNote="阶段推进标准化，预测更准确"
        extra={
          <Button icon={<PartitionOutlined />} onClick={() => router.push("/opportunities/pipeline")}>
            商机管道
          </Button>
        }
      />

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={8}>
          <Card styles={{ body: { padding: 24 } }}>
            <Statistic title="商机总金额" value={money(totalAmount)} styles={{ content: { fontSize: 24, fontWeight: 700 } }} />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card styles={{ body: { padding: 18 } }}>
            <Statistic title="进行中金额" value={money(openAmount)} styles={{ content: { fontSize: 24, fontWeight: 700, color: "#1668dc" } }} />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card styles={{ body: { padding: 18 } }}>
            <Statistic
              title="加权预测（金额 × 概率）"
              value={money(forecast)}
              styles={{ content: { fontSize: 24, fontWeight: 700, color: "#16a34a" } }}
            />
          </Card>
        </Col>
      </Row>

      <Card styles={{ body: { padding: 22 } }}>
        <Space style={{ marginBottom: 14 }} wrap>
          <Select
            style={{ width: 130 }}
            placeholder="全部阶段"
            allowClear
            value={f.stage || undefined}
            onChange={(v) => apply({ stage: v ?? "" })}
            options={OPP_STAGES.map((s) => ({ value: s, label: s }))}
          />
          <Select
            style={{ width: 120 }}
            placeholder="全部状态"
            allowClear
            value={f.status || undefined}
            onChange={(v) => apply({ status: v ?? "" })}
            options={[
              { value: "OPEN", label: "进行中" },
              { value: "WON", label: "已赢单" },
              { value: "LOST", label: "已丢单" },
            ]}
          />
          <Select
            style={{ width: 126 }}
            placeholder="全部成员"
            allowClear
            value={f.ownerId || undefined}
            onChange={(v) => apply({ ownerId: v ?? "" })}
            options={成员选项(users)}
          />
          <Input
            style={{ width: 220 }}
            placeholder="商机名称 / 客户"
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
              setF({ keyword: "", stage: "", status: "", ownerId: "" });
              startTransition(() => router.push("/opportunities"));
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
            新建商机
          </Button>
        </Space>

        <Table<OppRow>
          rowKey="id"
          size="middle"
          dataSource={rows}
          columns={columns}
          loading={pending}
          scroll={{ x: 1570 }}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条`, showSizeChanger: true }}
        />
      </Card>

      <Modal
        open={open}
        title={editing ? "编辑商机" : "新建商机"}
        onCancel={() => setOpen(false)}
        onOk={onOk}
        okText="保存"
        cancelText="取消"
        width={640}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item name="name" label="商机名称" rules={[{ required: true, message: "请填写商机名称" }]}>
                <Input placeholder="如：CRM 系统企业版年度采购" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="customerId" label="所属客户" rules={[{ required: true, message: "请选择客户" }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="选择客户"
                  options={customers.map((c) => ({ value: c.id, label: c.name }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="amount" label="商机金额（元）" rules={[{ required: true }]}>
                <InputNumber<number>
                  min={0}
                  step={10000}
                  style={{ width: "100%" }}
                  formatter={(v) => `¥ ${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
                  parser={(v) => Number(v?.replace(/[¥,\s]/g, "") ?? 0)}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="stage" label="阶段">
                <Select
                  options={OPP_STAGES.map((s) => ({ value: s, label: s }))}
                  onChange={(v) => form.setFieldValue("probability", STAGE_PROBABILITY[v] ?? 20)}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="status" label="状态">
                <Select
                  options={[
                    { value: "OPEN", label: "进行中" },
                    { value: "WON", label: "已赢单" },
                    { value: "LOST", label: "已丢单" },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="ownerId" label="负责人" rules={[{ required: true }]}>
                <Select options={成员选项(users)} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="expectedDealAt" label="预计成交">
                <DatePicker style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item name="probability" label="成交概率 (%)">
                <Slider marks={{ 0: "0", 50: "50", 100: "100" }} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="remark" label="备注">
                <Input.TextArea rows={2} placeholder="竞争对手、决策周期、风险点…" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
}
