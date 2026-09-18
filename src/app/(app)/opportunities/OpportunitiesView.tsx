"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input, Button, Space, Select, Tag, Modal, Form, Row, Col, InputNumber, DatePicker, Slider, App, Dropdown } from "antd";
import {
  SearchOutlined,
  PlusOutlined,
  MoreOutlined,
  DeleteOutlined,
  EditOutlined,
  ReloadOutlined,
  PartitionOutlined,
} from "@ant-design/icons";
import { PageHead, CustomerLink, UserCell } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
import { OPP_STAGES, STAGE_PROBABILITY } from "@/lib/constants";
import { money, fmtDate, dayjs, 成员选项, 独自一人, 可选成员 } from "@/lib/utils";
import { saveOpportunity, deleteOpportunities, moveStage, setOppStatus } from "./actions";
import { useBusiness } from "@/lib/business-client";

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
  直接新建,
}: {
  rows: OppRow[];
  users: 可选成员[];
  customers: { id: string; name: string }[];
  filters: { keyword: string; stage: string; status: string; ownerId: string };
  /** 进来就把新建表单打开（管道页那个「新建商机」的落点） */
  直接新建?: boolean;
}) {
  const router = useRouter();
  const b = useBusiness();
  const { message, modal } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [f, setF] = useState(filters);
  const [open, setOpen] = useState(Boolean(直接新建));
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

  const 列表: 列<OppRow>[] = [
    { title: "商机", key: "name", dataIndex: "name", width: 200, 常驻: true, render: (v) => <span className="link-strong">{v}</span> },
    {
      title: `所属${b.customer}`, 列名: `所属${b.customer}`, key: "customerName", dataIndex: "customerName", width: 170,
      render: (v, r) => <CustomerLink id={r.customerId} name={v} />,
    },
    {
      title: "金额", key: "amount", dataIndex: "amount", width: 110,
      sorter: (a, b2) => a.amount - b2.amount,
      render: (v) => <span style={{ fontWeight: 600 }}>{money(v)}</span>,
    },
    {
      title: "阶段", key: "stage", dataIndex: "stage", width: 140,
      render: (v, r) => (
        <Select
          size="small"
          value={v}
          variant="borderless"
          style={{ width: 128 }}
          disabled={r.status !== "OPEN"}
          options={OPP_STAGES.map((s2) => ({ value: s2, label: s2 }))}
          onChange={async (s2) => {
            const res = await moveStage(r.id, s2);
            if (!res.ok) {
              message.error(res.error);
              router.refresh();
              return;
            }
            message.success(`已推进到「${s2}」`);
            router.refresh();
          }}
        />
      ),
    },
    { title: "概率", key: "probability", dataIndex: "probability", width: 76, render: (v) => `${v}%` },
    { title: "负责人", key: "ownerName", dataIndex: "ownerName", width: 120, render: (v) => <UserCell name={v} size={24} /> },

    { title: "预计成交", key: "expectedDealAt", dataIndex: "expectedDealAt", width: 116, 默认: false, render: (v) => <span className="muted nowrap">{fmtDate(v)}</span> },
    {
      title: "状态", key: "status", dataIndex: "status", width: 106, 默认: false,
      render: (v) => (
        <Tag color={v === "WON" ? "success" : v === "LOST" ? "error" : "processing"} style={{ margin: 0, borderRadius: 6 }}>
          {v === "WON" ? "已赢单" : v === "LOST" ? "已丢单" : "进行中"}
        </Tag>
      ),
    },
    {
      title: "", key: "act", width: 110, 常驻: true, fixed: "right",
      render: (_, r) => (
        <Space size={2}>
          {/* 赢单 / 丢单 收进「更多」：一行里摆两个文字按钮太吵，六列也就挤不下了。
              它们是结果不是日常动作，一天点不了几次 */}
          {r.status === "OPEN" && (
            <Dropdown
              menu={{
                items: [
                  {
                    key: "won",
                    label: "标记赢单",
                    onClick: async () => {
                      await setOppStatus(r.id, "WON");
                      message.success("恭喜赢单！");
                      router.refresh();
                    },
                  },
                  {
                    key: "lost",
                    label: "标记丢单",
                    danger: true,
                    onClick: async () => {
                      await setOppStatus(r.id, "LOST");
                      router.refresh();
                    },
                  },
                ],
              }}
            >
              <Button aria-label={`${r.name} 的更多操作`} title="更多" type="text" size="small" icon={<MoreOutlined />} />
            </Dropdown>
          )}
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
      {/* 列表和管道是同一批商机的两种视图，所以「管道」是页头上的次动作，
          不再为它常驻一列中栏（设计稿 03/LAYOUT：中栏不是默认栏位）。 */}
      <PageHead
        title="商机"
        subtitle="进行中与已关闭的商机"
        extra={
          <Space>
            <Button icon={<PartitionOutlined />} onClick={() => router.push("/opportunities/pipeline")}>
              管道
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
        }
      />

      {/*
        原来这里是三张各占三分之一屏的统计卡。它们说的是同一件事的三个侧面，
        用不着三张卡、三条边框、三块留白——一行就够，而且紧挨着表格，
        看完数直接往下看是哪几单撑起来的。
        **一条商机都没有时整行不出现**：0 / 0 / 0 不是信息，是噪音。
      */}
      <DataList<OppRow>
        页="opportunities"
        空库={rows.length === 0 && !Object.values(filters).some((v) => v)}
        列={列表}
        行={rows}
        加载中={pending}
        空态={{
          title: "还没有商机",
          hint: `商机是「在谈的那一单」：金额多少、谈到哪一步、大概什么时候成。它挂在${b.customer}下面，签约之后再登记成签约记录。`,
          primary: { label: "新建第一条商机", onClick: () => { setEditing(null); setOpen(true); } },
        }}
        汇总={
          /* 一条药丸，摆在工具栏和表格之间（设计稿 15/PAGE）：
             筛完看到的就是这一筛的总额和预测，紧接着往下看是哪几单撑起来的。
             **一条商机都没有时不出现**：0 / 0 不是信息，是噪音 */
          rows.length > 0 ? (
            <div
              className="list-sum"
              title={`总额：列表里这些商机的金额合计（进行中 ${money(openAmount)}）\n加权预测：Σ(进行中商机金额 × 成交概率)，概率是每条商机上自己填的`}
            >
              总额 {money(totalAmount)} · 加权预测 {money(forecast)}
            </div>
          ) : null
        }
        筛选={
          <Space wrap size={[10, 10]}>
            <Input
              style={{ width: 240 }}
              placeholder={`商机名称 / ${b.customer}`}
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
              style={{ width: 130 }}
              placeholder="全部阶段"
              allowClear
              value={f.stage || undefined}
              onChange={(v) => apply({ stage: v ?? "" })}
              options={OPP_STAGES.map((s2) => ({ value: s2, label: s2 }))}
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
            {Object.values(f).some(Boolean) && (
              <Button
                icon={<ReloadOutlined />}
                onClick={() => {
                  setF({ keyword: "", stage: "", status: "", ownerId: "" });
                  startTransition(() => router.push("/opportunities"));
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
            {/* 只有一个人时不问归属，见 lib/utils.ts 的 独自一人 */}
            {!独自一人(users, editing?.ownerId) && (
              <Col span={8}>
                <Form.Item name="ownerId" label="负责人" rules={[{ required: true }]}>
                  <Select options={成员选项(users)} />
                </Form.Item>
              </Col>
            )}
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
