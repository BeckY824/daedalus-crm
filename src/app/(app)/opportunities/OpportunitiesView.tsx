"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Input, Button, Space, Select, Tag, Modal, Form, Row, Col, InputNumber, DatePicker, Slider, App, Dropdown, Popover } from "antd";
import {
  PlusOutlined,
  MoreOutlined,
  DeleteOutlined,
  EditOutlined,
  ReloadOutlined,
  PartitionOutlined,
} from "@ant-design/icons";
import ListSearch from "@/components/ListSearch";
import { PageHead, CustomerLink, UserCell } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
import { OPP_STAGES, STAGE_PROBABILITY } from "@/lib/constants";
import { money, fmtDate, dayjs, 成员选项, 独自一人, 可选成员 } from "@/lib/utils";
import { saveOpportunity, deleteOpportunities, moveStage, setOppStatus } from "./actions";
import { saveContract } from "../customers/actions";
import InlineConfirm from "@/components/InlineConfirm";
import { 金额格式 } from "@/lib/money-input";
import { useBusiness } from "@/lib/business-client";
import { useUrlFilters } from "@/lib/url-filters";

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
  总数,
  users,
  customers,
  filters,
  直接新建,
}: {
  rows: OppRow[];
  /** 库里一共多少条。行只取了前 300，分页条不能拿行数冒充总数 */
  总数: number;
  users: 可选成员[];
  customers: { id: string; name: string }[];
  filters: { keyword: string; stage: string; status: string; ownerId: string };
  /** 进来就把新建表单打开（管道页那个「新建商机」的落点） */
  直接新建?: boolean;
}) {
  const router = useRouter();
  const b = useBusiness();
  const { message, modal } = App.useApp();
  const { f, setF, apply, reset, pending } = useUrlFilters("/opportunities", filters);
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
      // 金额不给默认值：原来默认 ¥100,000，忘了改就平白多出一单十万，直接进总额和加权预测
      form.setFieldsValue({
        stage: "初步沟通",
        status: "OPEN",
        probability: 20,
        ownerId: users[0]?.id,
      });
    }
  }, [open, editing, form, users]);

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

  /** 哪一行正在问「标为丢单？」/「标为赢单」。从「更多」菜单里点进来，就地问，不弹框 */
  const [问丢单, set问丢单] = useState<string | null>(null);
  const [问赢单, set问赢单] = useState<string | null>(null);

  /**
   * 标丢单：就地确认之后才写，写完给一次撤销（2026-09-28 审查 S7）。
   * 撤销走 setOppStatus 改回进行中，**阶段和概率原样带回去**——丢单会把概率清零，
   * 只改 status 的话人手填的 75% 就没了。
   */
  async function 标丢单(r: OppRow) {
    const res = await setOppStatus(r.id, "LOST");
    if (!res.ok) return void message.error(res.error);
    router.refresh();
    const key = `lost-${r.id}`;
    message.success({
      key,
      content: (
        <span>
          「{r.name}」已标为丢单
          <Button
            type="link"
            size="small"
            onClick={async () => {
              message.destroy(key);
              const back = await setOppStatus(r.id, "OPEN", { stage: r.stage, probability: r.probability });
              if (!back.ok) return void message.error(back.error);
              message.success(`「${r.name}」已改回进行中`);
              router.refresh();
            }}
          >
            撤销
          </Button>
        </span>
      ),
      duration: 6,
    });
  }

  /**
   * 标赢单，顺手问一句要不要登记签约（2026-09-28 审查 S3）。
   * 原来这两条线互不相通：赢了单，本月签约金额和客户状态都不动。
   * 选登记就走 saveContract——查重、留痕、把客户推到「已签约」都在那里面，这里不另写一遍。
   */
  async function 标赢单(r: OppRow, 签约: { amount: number; signedAt: Date } | null) {
    const res = await setOppStatus(r.id, "WON");
    if (!res.ok) return void message.error(res.error);
    set问赢单(null);
    let 另 = "";
    if (签约) {
      const c = await saveContract({ customerId: r.customerId, amount: 签约.amount, signedAt: 签约.signedAt, remark: `商机「${r.name}」赢单时登记` });
      if (c.ok) 另 = `，签约 ${money(签约.amount)} 已登记`;
      else if ("duplicate" in c) {
        message.warning(`${r.customerName} 在 ${fmtDate(c.duplicate.signedAt)} 已有一笔 ${money(c.duplicate.amount)} 的签约，没有重复登记`);
      } else message.error(c.error);
    }
    message.success(`恭喜赢单${另}`);
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
        // 问「标为丢单？」那一句比这一格宽：盖在左边一格上（.opp-act），不临时加宽——加宽整张表会跳一下
        <span className="opp-act">
        <InlineConfirm
          问="标为丢单？"
          是="丢单"
          开={问丢单 === r.id}
          set开={(v) => set问丢单(v ? r.id : null)}
          做={() => 标丢单(r)}
        >
        <Space size={2}>
          {/* 赢单 / 丢单 收进「更多」：一行里摆两个文字按钮太吵，六列也就挤不下了。
              它们是结果不是日常动作，一天点不了几次。
              两样都不再一点就生效：丢单就地问一句，赢单就地问要不要顺手登记签约 */}
          {r.status === "OPEN" && (
            <Popover
              open={问赢单 === r.id}
              trigger={[]}
              placement="bottomRight"
              destroyOnHidden
              content={<WonAsk r={r} 做={(签约) => 标赢单(r, 签约)} 取消={() => set问赢单(null)} />}
            >
              <Dropdown
                menu={{
                  items: [
                    { key: "won", label: "标记赢单", onClick: () => { set问丢单(null); set问赢单(r.id); } },
                    { key: "lost", label: "标记丢单", danger: true, onClick: () => { set问赢单(null); set问丢单(r.id); } },
                  ],
                }}
              >
                <Button aria-label={`${r.name} 的更多操作`} title="更多" type="text" size="small" icon={<MoreOutlined />} />
              </Dropdown>
            </Popover>
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
        </InlineConfirm>
        </span>
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
        截断={{ 总数 }}
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
            <ListSearch
              width={240}
              placeholder={`商机名称 / ${b.customer}`}
              value={f.keyword}
              onChange={(v) => setF({ ...f, keyword: v })}
              onSearch={(v) => apply({ keyword: v })}
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
                onClick={reset}
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
              <Form.Item name="amount" label="商机金额（元）" rules={[{ required: true, message: "请填写商机金额" }]}>
                <InputNumber<number>
                  min={0}
                  step={10000}
                  style={{ width: "100%" }}
                  prefix="¥"
                  placeholder="如 50,000"
                  formatter={金额格式}
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

/**
 * 「标记赢单」的就地确认：顺手登记签约吗。金额带商机金额、日期今天，都能改；也可以只标赢单。
 * 放在 Popover 里而不是弹框：它就是一句问话加两个可改的数，盖半屏不值得。
 */
function WonAsk({ r, 做, 取消 }: { r: OppRow; 做: (签约: { amount: number; signedAt: Date } | null) => Promise<void>; 取消: () => void }) {
  const [amount, setAmount] = useState<number | null>(r.amount > 0 ? r.amount : null);
  const [day, setDay] = useState(dayjs());
  const [忙, set忙] = useState<"签" | "只" | null>(null);
  const 跑 = async (哪个: "签" | "只") => {
    set忙(哪个);
    try {
      await 做(哪个 === "签" && amount ? { amount, signedAt: day.toDate() } : null);
    } finally {
      set忙(null);
    }
  };
  return (
    <div className="won-ask">
      <div className="won-ask-t">「{r.name}」标为赢单</div>
      <div className="won-ask-s">顺手给 {r.customerName} 登记一笔签约？</div>
      <Space size={8}>
        <InputNumber<number>
          aria-label="签约金额"
          prefix="¥"
          min={0}
          step={1000}
          style={{ width: 150 }}
          placeholder="签约金额"
          value={amount}
          onChange={(v) => setAmount(v)}
          formatter={金额格式}
        />
        <DatePicker aria-label="签约日期" allowClear={false} value={day} onChange={(d) => d && setDay(d)} style={{ width: 140 }} />
      </Space>
      <Space size={8} className="won-ask-b">
        <Button type="primary" size="small" loading={忙 === "签"} disabled={!amount || (忙 !== null && 忙 !== "签")} onClick={() => void 跑("签")}>
          赢单并登记签约
        </Button>
        <Button size="small" loading={忙 === "只"} disabled={忙 !== null && 忙 !== "只"} onClick={() => void 跑("只")}>
          只标赢单
        </Button>
        <Button size="small" type="text" onClick={取消}>取消</Button>
      </Space>
    </div>
  );
}
