"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Card,
  Row,
  Col,
  Button,
  Tabs,
  Tag,
  Space,
  Typography,
  Breadcrumb,
  Checkbox,
  Empty,
  Segmented,
  Avatar,
  Dropdown,
  App,
  Statistic,
  Table,
  Tooltip,
  Select,
} from "antd";
import {
  ArrowLeftOutlined,
  PlusOutlined,
  PhoneOutlined,
  TeamOutlined,
  ShopOutlined,
  MailOutlined,
  MessageOutlined,
  CarryOutOutlined,
  BellOutlined,
  EllipsisOutlined,
  FileTextOutlined,
  EditOutlined,
  DeleteOutlined,
  DownOutlined,
  CheckCircleOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import {
  FOLLOW_TYPES,
  FOLLOW_TYPE_MAP,
  FOLLOW_RECORD_STATUS_COLOR,
  DECISION_STATUS_COLOR,
} from "@/lib/constants";
import { dayjs, duration, fmtDate, fmtDateTime, initial, avatarColor, money, maskPhone, smartTime, 可选成员 } from "@/lib/utils";
import { PageHead, FollowStatusTag, StageTag, CompanyLogo } from "@/components/ui";
import FollowUpForm from "./FollowUpForm";
import BriefModal from "./BriefModal";
import TaskForm from "./TaskForm";
import PlanForm from "./PlanForm";
import ContactForm from "./ContactForm";
import ContractForm, { type ContractRow } from "./ContractForm";
import CustomerForm, { type CustomerRow } from "../CustomerForm";
import { toggleTask, deleteTask, deleteFollowUp, completePlan, deleteContact } from "./actions";
import { deleteContract } from "../actions";

/**
 * 删掉最后一笔签约后跟进状态退到哪一档。
 * 不由系统替人决定：退单和录错是两回事，只有操作的人知道是哪种。
 */
const REVERT_CHOICES = [
  { value: "意向较高", label: "意向较高 · 与家人商议（谈崩了，还想再争取）", decision: "与家人商议" },
  { value: "跟进中", label: "跟进中 · 了解中（录错了，回到普通跟进）", decision: "了解中" },
  { value: "已流失", label: "已流失 · 暂不考虑（确定不报了）", decision: "暂不考虑" },
] as const;

type FollowUp = {
  id: string;
  type: string;
  title: string;
  content: string;
  status: string;
  duration: number | null;
  occurredAt: string;
  dueAt: string | null;
  attachment: string | null;
  attachSize: string | null;
  participants: string | null;
  ownerName: string;
  contactName: string | null;
  contactPosition: string | null;
  contactId: string | null;
  opportunityId: string | null;
};

export type ContactRow = {
  id: string;
  name: string;
  position: string | null;
  phone: string | null;
  email: string | null;
  wechat: string | null;
  isPrimary: boolean;
  remark: string | null;
};

type Props = {
  customer: CustomerRow;
  contacts: ContactRow[];
  opportunities: {
    id: string;
    name: string;
    amount: number;
    stage: string;
    status: string;
    probability: number;
    expectedDealAt: string | null;
  }[];
  contracts: ContractRow[];
  tasks: { id: string; title: string; dueAt: string | null; done: boolean }[];
  plan: { id: string; subject: string; plannedAt: string; method: string } | null;
  followUps: FollowUp[];
  users: 可选成员[];
  channels: { id: string; name: string }[];
  /** 可作为推荐人的已有学员 */
  referrableCustomers: { id: string; name: string }[];
  stats: { followCount: number; callSeconds: number; meetingCount: number; emailCount: number };
  /** 服务端是否配置了 AI（LLM_API_KEY）。没配时相关入口整体不渲染 */
  aiEnabled: boolean;
};

const TYPE_ICON: Record<string, React.ReactNode> = {
  PHONE: <PhoneOutlined />,
  MEETING: <TeamOutlined />,
  VISIT: <ShopOutlined />,
  EMAIL: <MailOutlined />,
  SMS: <MessageOutlined />,
  TASK: <CarryOutOutlined />,
  REMIND: <BellOutlined />,
  OTHER: <EllipsisOutlined />,
};

export default function CustomerDetailView({
  customer,
  contacts,
  contracts,
  opportunities,
  tasks,
  plan,
  followUps,
  users,
  channels,
  referrableCustomers,
  stats,
  aiEnabled,
}: Props) {
  const router = useRouter();
  const { message, modal } = App.useApp();

  // 删除签约时弹窗里选的回退档位。放 ref 是因为 modal.confirm 的内容
  // 不参与 React 重渲染，用 state 的话 onOk 读到的还是初值
  const revertChoice = useRef<string>(REVERT_CHOICES[0].value);

  const [typeFilter, setTypeFilter] = useState<string>("全部");
  const [tab, setTab] = useState("timeline");

  const [followOpen, setFollowOpen] = useState(false);
  const [editingFollow, setEditingFollow] = useState<FollowUp | null>(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<ContactRow | null>(null);
  const [custOpen, setCustOpen] = useState(false);
  const [contractOpen, setContractOpen] = useState(false);
  const [editingContract, setEditingContract] = useState<ContractRow | null>(null);

  const filtered = useMemo(
    () => (typeFilter === "全部" ? followUps : followUps.filter((f) => f.type === typeFilter)),
    [followUps, typeFilter],
  );

  const openTasks = tasks.filter((t) => !t.done);

  function newFollow(type?: string) {
    setEditingFollow(type ? ({ type } as FollowUp) : null);
    setFollowOpen(true);
  }

  const oppColumns: ColumnsType<Props["opportunities"][number]> = [
    { title: "商机名称", dataIndex: "name", render: (v, r) => <Link href={`/opportunities?keyword=${encodeURIComponent(r.name)}`} className="link-strong">{v}</Link> },
    { title: "金额", dataIndex: "amount", width: 164, render: (v) => <span style={{ fontWeight: 500 }}>{money(v)}</span> },
    { title: "阶段", dataIndex: "stage", width: 130, render: (v) => <StageTag stage={v} /> },
    { title: "概率", dataIndex: "probability", width: 94, render: (v) => `${v}%` },
    { title: "预计成交", dataIndex: "expectedDealAt", width: 142, render: (v) => fmtDate(v) },
    {
      title: "状态",
      dataIndex: "status",
      width: 108,
      render: (v) => (
        <Tag color={v === "WON" ? "success" : v === "LOST" ? "error" : "processing"} style={{ margin: 0, borderRadius: 6 }}>
          {v === "WON" ? "已赢单" : v === "LOST" ? "已丢单" : "进行中"}
        </Tag>
      ),
    },
  ];

  const contactColumns: ColumnsType<ContactRow> = [
    {
      title: "姓名",
      dataIndex: "name",
      render: (v, r) => (
        <Space size={8}>
          <Avatar size={34} style={{ background: avatarColor(v), fontSize: 15 }}>{initial(v)}</Avatar>
          <span className="link-strong">{v}</span>
          {r.isPrimary && <Tag color="blue" style={{ margin: 0, borderRadius: 6 }}>关键联系人</Tag>}
        </Space>
      ),
    },
    { title: "关系", dataIndex: "position", render: (v) => v ?? "—" },
    { title: "电话", dataIndex: "phone", render: (v) => v ?? "—" },
    { title: "邮箱", dataIndex: "email", render: (v) => v ?? "—" },
    { title: "微信", dataIndex: "wechat", render: (v) => v ?? "—" },
    {
      title: "",
      key: "act",
      width: 96,
      render: (_, r) => (
        <Space size={2}>
          <Button type="text" size="small" icon={<EditOutlined />} onClick={() => { setEditingContact(r); setContactOpen(true); }} />
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() =>
              modal.confirm({
                title: `删除联系人「${r.name}」？`,
                okText: "删除",
                okButtonProps: { danger: true },
                cancelText: "取消",
                async onOk() {
                  await deleteContact(r.id);
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
        icon={<FileTextOutlined />}
        title="跟进记录"
        subtitle="每次沟通都有迹可循，客户推进更有节奏"
        tag="跟进记录"
        tagNote="全面记录客户动态，驱动成交进程"
        extra={
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/customers")}>
            返回
          </Button>
        }
      />

      <Breadcrumb
        style={{ marginBottom: 12 }}
        items={[{ title: <Link href="/customers">客户管理</Link> }, { title: customer.name }]}
      />

      {/* 客户信息条 */}
      <Card styles={{ body: { padding: "24px 26px" } }} style={{ marginBottom: 18 }}>
        <Row gutter={[16, 14]} align="middle">
          {/* 公司名较长，标签另起一行，避免窄屏下名称被挤折行 */}
          <Col xs={24} lg={8} xxl={9}>
            <Space size={14} align="start" style={{ width: "100%" }}>
              <CompanyLogo name={customer.name} size={44} />
              <div style={{ minWidth: 0 }}>
                <Typography.Title level={4} style={{ margin: 0, fontSize: 22, lineHeight: 1.35 }}>
                  {customer.name}
                </Typography.Title>
                <Space size={[8, 6]} wrap style={{ marginTop: 7 }}>
                  <FollowStatusTag status={customer.followStatus} />
                  <Tag color={DECISION_STATUS_COLOR[customer.decisionStatus] ?? "default"} style={{ margin: 0, borderRadius: 6, fontSize: 13 }}>
                    {customer.decisionStatus}
                  </Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 14 }}>
                    {[customer.school, customer.major, customer.grade].filter(Boolean).join(" · ") || "未填院校信息"}
                  </Typography.Text>
                </Space>
              </div>
            </Space>
          </Col>

          <Col xs={12} sm={8} lg={3}>
            <Field label="联系电话" value={customer.phone} />
          </Col>
          <Col xs={12} sm={8} lg={3}>
            <Field label="销售负责人" value={customer.salesOwnerName} />
          </Col>
          <Col xs={12} sm={8} lg={3}>
            <Field label="渠道负责人" value={customer.channelOwnerName ?? "—"} />
          </Col>
          <Col xs={12} sm={8} lg={3}>
            <Field label="预计签约" value={fmtDate(customer.expectedSignAt)} />
          </Col>
          <Col xs={12} sm={8} lg={3}>
            <Field
              label="签约金额"
              value={customer.signedAmount > 0 ? money(customer.signedAmount) : "未签约"}
            />
          </Col>

          <Col xs={24} lg={3} xxl={2} style={{ textAlign: "right" }}>
            <Space.Compact>
              {aiEnabled && (
                <Button icon={<ThunderboltOutlined />} onClick={() => setBriefOpen(true)}>
                  简报
                </Button>
              )}
              <Button type="primary" onClick={() => newFollow()}>
                新建跟进
              </Button>
              <Dropdown
                menu={{
                  items: [
                    ...FOLLOW_TYPES.map((t) => ({ key: t.value, label: t.label, onClick: () => newFollow(t.value) })),
                    { type: "divider" as const },
                    { key: "edit", icon: <EditOutlined />, label: "编辑学员", onClick: () => setCustOpen(true) },
                  ],
                }}
              >
                <Button type="primary" icon={<DownOutlined />} />
              </Dropdown>
            </Space.Compact>
          </Col>
        </Row>
      </Card>

      <Row gutter={[16, 16]}>
        {/* 左：时间线 */}
        <Col xs={24} xl={17}>
          <Card styles={{ body: { paddingTop: 0 } }}>
            <Tabs
              activeKey={tab}
              onChange={setTab}
              items={[
                { key: "timeline", label: "跟进动态" },
                { key: "contracts", label: `签约 (${contracts.length})` },
                { key: "opps", label: `商机 (${opportunities.length})` },
                { key: "tasks", label: `待办任务 (${openTasks.length})` },
                { key: "contacts", label: `联系人 (${contacts.length})` },
                { key: "info", label: "客户资料" },
              ]}
            />

            {tab === "timeline" && (
              <>
                <Segmented
                  size="small"
                  value={typeFilter}
                  onChange={(v) => setTypeFilter(String(v))}
                  style={{ marginBottom: 6 }}
                  options={["全部", ...FOLLOW_TYPES.map((t) => ({ value: t.value, label: t.label.replace(/沟通|记录|任务|提醒|会议|拜访/, (m) => m) }))]}
                />

                {filtered.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="暂无跟进记录"
                    style={{ padding: "40px 0" }}
                  >
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => newFollow()}>
                      记录第一次跟进
                    </Button>
                  </Empty>
                ) : (
                  filtered.map((f) => {
                    const meta = FOLLOW_TYPE_MAP[f.type] ?? FOLLOW_TYPE_MAP.OTHER;
                    return (
                      <div key={f.id} className="follow-item">
                        <div className="follow-dot" style={{ background: meta.color }}>
                          {TYPE_ICON[f.type]}
                        </div>
                        <div className="follow-body">
                          <div className="follow-head">
                            <span style={{ fontWeight: 600, fontSize: 16 }}>{meta.label}</span>
                            {/* 标题现在是选填，填了才显示；早先必填却从不展示，
                                等于逼人每条编一句没人看的话 */}
                            {f.title?.trim() && (
                              <span style={{ color: "#475569", fontSize: 14 }}>· {f.title}</span>
                            )}
                            <Tag
                              color={FOLLOW_RECORD_STATUS_COLOR[f.status] ?? "default"}
                              style={{ margin: 0, borderRadius: 6, fontSize: 13 }}
                            >
                              {f.status}
                            </Tag>
                            <div style={{ flex: 1 }} />
                            {f.duration ? (
                              <Typography.Text type="secondary" style={{ fontSize: 14 }}>
                                时长 {duration(f.duration)}
                              </Typography.Text>
                            ) : null}
                            <Space size={0}>
                              <Button
                                type="text"
                                size="small"
                                icon={<EditOutlined style={{ fontSize: 14 }} />}
                                onClick={() => {
                                  setEditingFollow(f);
                                  setFollowOpen(true);
                                }}
                              />
                              <Button
                                type="text"
                                size="small"
                                danger
                                icon={<DeleteOutlined style={{ fontSize: 14 }} />}
                                onClick={() =>
                                  modal.confirm({
                                    title: "删除这条跟进记录？",
                                    okText: "删除",
                                    okButtonProps: { danger: true },
                                    cancelText: "取消",
                                    async onOk() {
                                      await deleteFollowUp(f.id, customer.id);
                                      message.success("已删除");
                                      router.refresh();
                                    },
                                  })
                                }
                              />
                            </Space>
                          </div>

                          <div className="follow-content">{f.content}</div>

                          {f.attachment && (
                            <div className="attach-chip">
                              <FileTextOutlined style={{ color: "#1668dc" }} />
                              {f.attachment}
                              {f.attachSize && <span style={{ color: "#94a3b8" }}>({f.attachSize})</span>}
                            </div>
                          )}

                          <div className="follow-meta">
                            {f.contactName && (
                              <Space size={6}>
                                <Avatar size={22} style={{ background: avatarColor(f.contactName), fontSize: 12 }}>
                                  {initial(f.contactName)}
                                </Avatar>
                                <span>
                                  {f.contactName}
                                  {f.contactPosition ? `（${f.contactPosition}）` : ""}
                                </span>
                              </Space>
                            )}
                            {f.participants && <span>参与人：{f.participants}</span>}
                            {f.dueAt && <span>截止时间 {fmtDateTime(f.dueAt)}</span>}
                            <div style={{ flex: 1 }} />
                            <span>{fmtDateTime(f.occurredAt)}</span>
                            <Space size={5}>
                              <Avatar size={22} style={{ background: avatarColor(f.ownerName), fontSize: 12 }}>
                                {initial(f.ownerName)}
                              </Avatar>
                              <span>{f.ownerName}</span>
                            </Space>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </>
            )}

            {tab === "contracts" && (
              <>
                <Space style={{ marginBottom: 14 }}>
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={() => { setEditingContract(null); setContractOpen(true); }}
                  >
                    登记签约
                  </Button>
                  {contracts.length > 0 && (
                    <Typography.Text type="secondary">
                      累计签约 {money(contracts.reduce((a, c) => a + c.amount, 0))}
                    </Typography.Text>
                  )}
                </Space>
                <Table<ContractRow>
                  rowKey="id"
                  size="middle"
                  dataSource={contracts}
                  pagination={false}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无签约记录" /> }}
                  columns={[
                    {
                      title: "签约金额",
                      dataIndex: "amount",
                      width: 180,
                      render: (v: number) => <span style={{ fontWeight: 600, fontSize: 16 }}>{money(v)}</span>,
                    },
                    { title: "签约时间", dataIndex: "signedAt", width: 160, render: (v) => fmtDate(v) },
                    { title: "备注", dataIndex: "remark", render: (v) => v ?? <span className="muted">—</span> },
                    {
                      title: "",
                      key: "act",
                      width: 96,
                      render: (_, r) => (
                        <Space size={2}>
                          <Button
                            type="text" size="small" icon={<EditOutlined />}
                            onClick={() => { setEditingContract(r); setContractOpen(true); }}
                          />
                          <Button
                            type="text" size="small" danger icon={<DeleteOutlined />}
                            onClick={() =>
                              modal.confirm({
                                title: "删除这条签约记录？",
                                content: (() => {
                                  const 是最后一笔 = contracts.length === 1;
                                  if (!是最后一笔) {
                                    return `金额 ${money(r.amount)}，删除后统计数据会同步变化。`;
                                  }
                                  return (
                                    <>
                                      <div>
                                        金额 {money(r.amount)}。这是该学员唯一一笔签约，
                                        删除后签约金额归零，跟进状态需要跟着退回，
                                        否则看板上会一直挂着「已签约、金额 0」。
                                      </div>
                                      <div style={{ marginTop: 12 }}>
                                        <div style={{ marginBottom: 6, fontSize: 13 }}>跟进状态退回到：</div>
                                        <Select
                                          style={{ width: "100%" }}
                                          defaultValue={revertChoice.current}
                                          onChange={(v) => (revertChoice.current = v)}
                                          options={[
                                            ...REVERT_CHOICES.map((c) => ({ value: c.value, label: c.label })),
                                            { value: "", label: "保持「已签约」不变（我知道自己在做什么）" },
                                          ]}
                                        />
                                      </div>
                                    </>
                                  );
                                })(),
                                okText: "删除", okButtonProps: { danger: true }, cancelText: "取消",
                                async onOk() {
                                  const 是最后一笔 = contracts.length === 1;
                                  const picked = REVERT_CHOICES.find((c) => c.value === revertChoice.current);
                                  const res = await deleteContract(
                                    r.id,
                                    customer.id,
                                    是最后一笔 && picked
                                      ? { followStatus: picked.value, decisionStatus: picked.decision }
                                      : null,
                                  );
                                  router.refresh();
                                  if (!res.ok) {
                                    message.error(res.error);
                                    return;
                                  }
                                  message.success(
                                    是最后一笔 && picked
                                      ? `已删除，跟进状态已退回「${picked.value}」`
                                      : "已删除",
                                  );
                                },
                              })
                            }
                          />
                        </Space>
                      ),
                    },
                  ]}
                />
              </>
            )}

            {tab === "opps" && (
              <Table
                rowKey="id"
                size="small"
                dataSource={opportunities}
                columns={oppColumns}
                pagination={false}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无商机" /> }}
              />
            )}

            {tab === "tasks" && (
              <div style={{ paddingBottom: 8 }}>
                <Button
                  type="dashed"
                  block
                  icon={<PlusOutlined />}
                  style={{ marginBottom: 12 }}
                  onClick={() => setTaskOpen(true)}
                >
                  新建任务
                </Button>
                {tasks.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务" />}
                {tasks.map((t) => (
                  <div
                    key={t.id}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px dashed #eef2f7" }}
                  >
                    <Checkbox
                      checked={t.done}
                      onChange={async (e) => {
                        await toggleTask(t.id, e.target.checked);
                        router.refresh();
                      }}
                    />
                    <span style={{ flex: 1, textDecoration: t.done ? "line-through" : "none", color: t.done ? "#94a3b8" : undefined }}>
                      {t.title}
                    </span>
                    <span style={{ fontSize: 14, color: "#94a3b8" }}>{smartTime(t.dueAt)}</span>
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined style={{ fontSize: 14 }} />}
                      onClick={async () => {
                        await deleteTask(t.id);
                        router.refresh();
                      }}
                    />
                  </div>
                ))}
              </div>
            )}

            {tab === "contacts" && (
              <>
                <Button
                  type="dashed"
                  block
                  icon={<PlusOutlined />}
                  style={{ marginBottom: 12 }}
                  onClick={() => {
                    setEditingContact(null);
                    setContactOpen(true);
                  }}
                >
                  添加联系人
                </Button>
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={contacts}
                  columns={contactColumns}
                  pagination={false}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无联系人" /> }}
                />
              </>
            )}

            {tab === "info" && (
              <div style={{ paddingBottom: 12 }}>
                <Row gutter={[16, 16]}>
                  <Col xs={12} md={8}><Field label="客户姓名" value={customer.name} /></Col>
                  <Col xs={12} md={8}><Field label="联系电话" value={customer.phone} /></Col>
                  <Col xs={12} md={8}><Field label="院校" value={customer.school ?? "—"} /></Col>
                  <Col xs={12} md={8}><Field label="专业" value={customer.major ?? "—"} /></Col>
                  <Col xs={12} md={8}><Field label="年级" value={customer.grade ?? "—"} /></Col>
                  <Col xs={12} md={8}><Field label="最近跟进" value={smartTime(customer.lastFollowAt)} /></Col>
                </Row>

                {/* 推荐关系：三个角色含义不同，分开展示避免混淆 */}
                <div className="section-title" style={{ margin: "22px 0 12px" }}>推荐关系</div>
                <Row gutter={[16, 16]}>
                  <Col xs={12} md={8}>
                    <Field label="推荐人" value={customer.referrerName ?? "自然流量"} />
                  </Col>
                  <Col xs={12} md={8}>
                    <Tooltip title="推荐链往上第二代，不足两代取链条最顶端">
                      <span><Field label="渠道归属" value={customer.attributionName ?? "—"} /></span>
                    </Tooltip>
                  </Col>
                  <Col xs={12} md={8}>
                    <Tooltip title="来自链条最顶端的外部渠道，整条推荐链永久继承">
                      <span><Field label="渠道负责人" value={customer.channelOwnerName ?? "—"} /></span>
                    </Tooltip>
                  </Col>
                </Row>

                <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
                  <Col xs={24}><Field label="备注" value={customer.remark ?? "—"} /></Col>
                </Row>
                <Button icon={<EditOutlined />} style={{ marginTop: 16 }} onClick={() => setCustOpen(true)}>
                  编辑学员资料
                </Button>
              </div>
            )}
          </Card>
        </Col>

        {/* 右：待办 / 计划 / 统计 / 联系人 */}
        <Col xs={24} xl={7}>
          <Space orientation="vertical" size={16} style={{ width: "100%" }}>
            <Card
              title={<span className="section-title">待办任务（{openTasks.length}）</span>}
              extra={<a onClick={() => setTab("tasks")} style={{ fontSize: 14 }}>全部 ›</a>}
              styles={{ body: { paddingTop: 6 } }}
            >
              {openTasks.length === 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 15 }}>暂无待办</Typography.Text>
              )}
              {openTasks.slice(0, 5).map((t) => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0" }}>
                  <Checkbox
                    checked={t.done}
                    onChange={async (e) => {
                      await toggleTask(t.id, e.target.checked);
                      message.success("已完成");
                      router.refresh();
                    }}
                  />
                  <span style={{ flex: 1, fontSize: 15 }}>{t.title}</span>
                  <span
                    style={{
                      fontSize: 14,
                      color: t.dueAt && dayjs(t.dueAt).isBefore(dayjs()) ? "#dc2626" : "#94a3b8",
                      flex: "none",
                    }}
                  >
                    {smartTime(t.dueAt)}
                  </span>
                </div>
              ))}
              <Button type="primary" block style={{ marginTop: 10 }} onClick={() => setTaskOpen(true)}>
                新建任务
              </Button>
            </Card>

            <Card title={<span className="section-title">下次跟进计划</span>} styles={{ body: { paddingTop: 10 } }}>
              {plan ? (
                <>
                  <Field label="跟进主题" value={plan.subject} />
                  <div style={{ height: 10 }} />
                  <Field label="计划时间" value={fmtDateTime(plan.plannedAt)} />
                  <div style={{ height: 10 }} />
                  <Field label="跟进方式" value={plan.method} />
                  <div style={{ height: 10 }} />
                  <Field label="负责人" value={customer.salesOwnerName} />
                  <Space style={{ marginTop: 14, width: "100%" }}>
                    <Button block onClick={() => setPlanOpen(true)}>编辑计划</Button>
                    <Button
                      type="primary"
                      icon={<CheckCircleOutlined />}
                      onClick={async () => {
                        await completePlan(plan.id);
                        message.success("计划已完成");
                        router.refresh();
                      }}
                    >
                      完成
                    </Button>
                  </Space>
                </>
              ) : (
                <>
                  <Typography.Text type="secondary" style={{ fontSize: 15 }}>
                    尚未安排下次跟进
                  </Typography.Text>
                  <Button type="primary" block style={{ marginTop: 12 }} onClick={() => setPlanOpen(true)}>
                    制定跟进计划
                  </Button>
                </>
              )}
            </Card>

            <Card title={<span className="section-title">沟通统计</span>} styles={{ body: { paddingTop: 8 } }}>
              <Row gutter={[8, 14]}>
                <Col span={12}>
                  <Statistic title="跟进次数" value={stats.followCount} styles={{ content: { fontSize: 26, fontWeight: 700 } }} />
                </Col>
                <Col span={12}>
                  <Statistic
                    title="通话时长"
                    value={duration(stats.callSeconds)}
                    styles={{ content: { fontSize: 26, fontWeight: 700 } }}
                  />
                </Col>
                <Col span={12}>
                  <Statistic title="会议次数" value={stats.meetingCount} styles={{ content: { fontSize: 26, fontWeight: 700 } }} />
                </Col>
                <Col span={12}>
                  <Statistic title="邮件沟通" value={stats.emailCount} styles={{ content: { fontSize: 26, fontWeight: 700 } }} />
                </Col>
              </Row>
            </Card>

            <Card
              title={<span className="section-title">关键联系人</span>}
              extra={<a onClick={() => setTab("contacts")} style={{ fontSize: 14 }}>全部 ›</a>}
              styles={{ body: { paddingTop: 6 } }}
            >
              {contacts.length === 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 15 }}>暂无联系人</Typography.Text>
              )}
              {contacts.slice(0, 4).map((c) => (
                <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 0" }}>
                  <Avatar size={36} style={{ background: avatarColor(c.name), fontSize: 16 }}>{initial(c.name)}</Avatar>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 500 }}>{c.name}</div>
                    <div style={{ fontSize: 13, color: "#94a3b8" }}>{c.position ?? maskPhone(c.phone)}</div>
                  </div>
                  <Space size={2}>
                    <Tooltip title={c.phone ?? "无电话"}>
                      <Button type="text" size="small" icon={<PhoneOutlined style={{ color: "#1668dc", fontSize: 15 }} />} />
                    </Tooltip>
                    <Tooltip title={c.email ?? "无邮箱"}>
                      <Button type="text" size="small" icon={<MailOutlined style={{ color: "#1668dc", fontSize: 15 }} />} />
                    </Tooltip>
                  </Space>
                </div>
              ))}
              <Button
                block
                style={{ marginTop: 10 }}
                onClick={() => {
                  setEditingContact(null);
                  setContactOpen(true);
                }}
              >
                添加联系人
              </Button>
            </Card>
          </Space>
        </Col>
      </Row>

      {/* 弹窗 */}
      <FollowUpForm
        open={followOpen}
        onClose={() => setFollowOpen(false)}
        onSaved={() => {
          setFollowOpen(false);
          router.refresh();
        }}
        customerId={customer.id}
        record={editingFollow}
        contacts={contacts}
        opportunities={opportunities}
        aiEnabled={aiEnabled}
      />
      <BriefModal
        open={briefOpen}
        onClose={() => setBriefOpen(false)}
        customerId={customer.id}
        customerName={customer.name}
      />
      <TaskForm
        open={taskOpen}
        onClose={() => setTaskOpen(false)}
        onSaved={() => {
          setTaskOpen(false);
          router.refresh();
        }}
        customerId={customer.id}
      />
      <PlanForm
        open={planOpen}
        onClose={() => setPlanOpen(false)}
        onSaved={() => {
          setPlanOpen(false);
          router.refresh();
        }}
        customerId={customer.id}
        record={plan}
      />
      <ContactForm
        open={contactOpen}
        onClose={() => setContactOpen(false)}
        onSaved={() => {
          setContactOpen(false);
          router.refresh();
        }}
        customerId={customer.id}
        record={editingContact}
      />
      <ContractForm
        open={contractOpen}
        customerId={customer.id}
        editing={editingContract}
        onClose={(saved) => {
          setContractOpen(false);
          setEditingContract(null);
          if (saved) router.refresh();
        }}
      />

      <CustomerForm
        open={custOpen}
        editing={customer}
        users={users}
        channels={channels}
        customers={referrableCustomers}
        onClose={(saved) => {
          setCustOpen(false);
          if (saved) router.refresh();
        }}
      />
    </>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div style={{ fontSize: 16, fontWeight: 500, color: "#10233d", marginTop: 3 }}>{value}</div>
    </div>
  );
}
