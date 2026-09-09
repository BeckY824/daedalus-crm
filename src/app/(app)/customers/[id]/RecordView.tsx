"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Dropdown, Input, Space, Tag, Avatar, Checkbox, Tooltip, App, Select, Typography } from "antd";
import {
  ArrowLeftOutlined,
  DownOutlined,
  EditOutlined,
  DeleteOutlined,
  PlusOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  PhoneOutlined,
  TeamOutlined,
  ShopOutlined,
  MailOutlined,
  MessageOutlined,
  CarryOutOutlined,
  BellOutlined,
  EllipsisOutlined,
  DollarOutlined,
} from "@ant-design/icons";
import { motion, AnimatePresence } from "motion/react";
import { FOLLOW_TYPES, FOLLOW_TYPE_MAP, FOLLOW_STATUSES, DECISION_STATUSES, FOLLOW_RECORD_STATUS_COLOR } from "@/lib/constants";
import { dayjs, duration, fmtDate, fmtDateTime, initial, avatarColor, money, smartTime, AVATAR_TEXT } from "@/lib/utils";
import { FollowStatusTag, StageTag, CompanyLogo, DecisionStatusTag } from "@/components/ui";
import { useBusiness } from "@/lib/business-client";
import { statusLabel } from "@/lib/business-config";
import FollowUpForm from "./FollowUpForm";
import TaskForm from "./TaskForm";
import PlanForm from "./PlanForm";
import ContactForm from "./ContactForm";
import ContractForm, { type ContractRow } from "./ContractForm";
import CustomerForm from "../CustomerForm";
import InlineField from "./InlineField";
import AiPanel from "./AiPanel";
import { toggleTask, deleteTask, deleteFollowUp, completePlan, deleteContact, saveFollowUp } from "./actions";
import { deleteContract } from "../actions";
import type { RecordProps, FollowUpRow, ContactRow } from "./types";

/**
 * 记录页（v0.4）：三栏。
 *   左：档案——点一下就能改，不弹窗
 *   中：一条时间线，跟进与签约按时间合成一条流；顶部是速记框，粘一段就能记
 *   右：AI 面板常驻——打开谁，它已经读完了谁；下面是计划与待办
 * 没有页签。联系人 / 商机 / 签约都是档案的一部分，放左栏。
 */

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

/** 删掉最后一笔签约后跟进状态退到哪一档：退单和录错是两回事，由操作的人选 */
const REVERT_CHOICES = [
  { value: "意向较高", label: "意向较高 · 与家人商议（谈崩了，还想再争取）", decision: "与家人商议" },
  { value: "跟进中", label: "跟进中 · 了解中（录错了，回到普通跟进）", decision: "了解中" },
  { value: "已流失", label: "已流失 · 暂不考虑（确定不报了）", decision: "暂不考虑" },
] as const;

type Entry =
  | { kind: "follow"; at: string; f: FollowUpRow }
  | { kind: "contract"; at: string; c: ContractRow };

export default function RecordView({
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
  aiEnabled,
}: RecordProps) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const b = useBusiness();
  const revertChoice = useRef<string>(REVERT_CHOICES[0].value);

  const [filter, setFilter] = useState<string>("全部");
  const [memo, setMemo] = useState("");
  const [quickSaving, setQuickSaving] = useState(false);

  const [followOpen, setFollowOpen] = useState(false);
  const [followInit, setFollowInit] = useState<{ record: FollowUpRow | null; aiText?: string }>({ record: null });
  const [taskOpen, setTaskOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<ContactRow | null>(null);
  const [custOpen, setCustOpen] = useState(false);
  const [contractOpen, setContractOpen] = useState(false);
  const [editingContract, setEditingContract] = useState<ContractRow | null>(null);

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [
      ...followUps.filter((f) => filter === "全部" || filter === f.type).map((f) => ({ kind: "follow" as const, at: f.occurredAt, f })),
      ...(filter === "全部" || filter === "CONTRACT" ? contracts.map((c) => ({ kind: "contract" as const, at: c.signedAt, c })) : []),
    ];
    return list.sort((a, b2) => dayjs(b2.at).valueOf() - dayjs(a.at).valueOf());
  }, [followUps, contracts, filter]);

  const openTasks = tasks.filter((t) => !t.done);
  const fingerprint = `${followUps.length}:${followUps[0]?.occurredAt ?? ""}:${followUps[0]?.id ?? ""}`;

  function openFollow(record: FollowUpRow | null, aiText?: string) {
    setFollowInit({ record, aiText });
    setFollowOpen(true);
  }

  /** 速记框的两个出口：交给 AI 解析，或者不解析直接记一笔「其他记录」 */
  async function quickSave() {
    const text = memo.trim();
    if (!text) return;
    setQuickSaving(true);
    const res = await saveFollowUp({
      customerId: customer.id,
      type: "OTHER",
      title: "",
      content: text,
      status: "已完成",
      occurredAt: new Date().toISOString(),
    });
    setQuickSaving(false);
    if (!res.ok) {
      message.error(res.error);
      return;
    }
    setMemo("");
    router.refresh();
  }

  return (
    <>
      <div className="rec-head">
        <Link href="/customers" className="rec-head-back">
          <ArrowLeftOutlined /> {b.customer}管理
        </Link>
        <h1 className="rec-head-name" style={{ margin: 0 }}>{customer.name}</h1>
        <span style={{ flex: 1 }} />
        <Space.Compact>
          <Button type="primary" onClick={() => openFollow(null)}>
            新建跟进
          </Button>
          <Dropdown
            menu={{
              items: [
                ...FOLLOW_TYPES.map((t) => ({ key: t.value, label: t.label, onClick: () => openFollow({ type: t.value } as FollowUpRow) })),
                { type: "divider" as const },
                { key: "edit", icon: <EditOutlined />, label: `编辑${b.customer}资料`, onClick: () => setCustOpen(true) },
              ],
            }}
          >
            <Button type="primary" icon={<DownOutlined />} />
          </Dropdown>
        </Space.Compact>
      </div>

      <div className="rec">
        {/* ================= 左栏：档案 ================= */}
        <aside className="rec-rail rec-card">
          <div className="rec-identity">
            <CompanyLogo name={customer.name} size={44} />
            <div style={{ minWidth: 0 }}>
              <div className="rec-identity-n">{customer.name}</div>
              <div className="rec-identity-s">{customer.phone}</div>
            </div>
          </div>
          <div style={{ padding: "6px 20px 14px", display: "flex", gap: 6, flexWrap: "wrap" }}>
            <StatusPicker customerId={customer.id} field="followStatus" value={customer.followStatus} options={FOLLOW_STATUSES.map((s) => ({ value: s, label: statusLabel(b, s) }))}>
              <FollowStatusTag status={customer.followStatus} />
            </StatusPicker>
            <StatusPicker customerId={customer.id} field="decisionStatus" value={customer.decisionStatus} options={DECISION_STATUSES.map((s) => ({ value: s, label: statusLabel(b, s) }))}>
              <DecisionStatusTag status={customer.decisionStatus} />
            </StatusPicker>
          </div>

          <div className="rec-sec">
            <div className="rec-sec-t">
              <span>档案</span>
              <Button type="link" size="small" style={{ padding: 0, height: "auto" }} onClick={() => setCustOpen(true)}>编辑全部</Button>
            </div>
            <InlineField customerId={customer.id} field="school" label={b.fields.school} value={customer.school} />
            <InlineField customerId={customer.id} field="major" label={b.fields.major} value={customer.major} />
            <InlineField customerId={customer.id} field="grade" label={b.fields.grade} value={customer.grade} kind="select" options={b.grades.map((g) => ({ value: g, label: g }))} />
            <InlineField customerId={customer.id} field="salesOwnerId" label="销售负责人" value={customer.salesOwnerId} kind="select" options={users.map((u) => ({ value: u.id, label: u.name }))} />
            <InlineField customerId={customer.id} field="expectedSignAt" label="预计签约" value={customer.expectedSignAt} kind="date" placeholder="未定" />
            <div className="rec-field" style={{ cursor: "default" }}>
              <div className="rec-field-k">签约金额</div>
              <div className="rec-field-v">{customer.signedAmount > 0 ? money(customer.signedAmount) : <span className="rec-field-empty">未签约</span>}</div>
            </div>
            <InlineField customerId={customer.id} field="remark" label="备注" value={customer.remark} kind="textarea" placeholder="点击写备注" />
          </div>

          <div className="rec-sec">
            <div className="rec-sec-t">
              <span>推荐关系</span>
            </div>
            <div className="rec-field" style={{ cursor: "default" }}>
              <div className="rec-field-k">推荐人</div>
              <div className="rec-field-v">{customer.referrerName ?? <span style={{ color: "#94a3b8" }}>自然流量</span>}</div>
            </div>
            <Tooltip title="推荐链往上第二代，不足两代取链条最顶端" placement="left">
              <div className="rec-field" style={{ cursor: "default" }}>
                <div className="rec-field-k">渠道归属</div>
                <div className="rec-field-v">{customer.attributionName ?? "—"}</div>
              </div>
            </Tooltip>
            <div className="rec-field" style={{ cursor: "default" }}>
              <div className="rec-field-k">渠道负责人</div>
              <div className="rec-field-v">{customer.channelOwnerName ?? "—"}</div>
            </div>
          </div>

          <div className="rec-sec">
            <div className="rec-sec-t">
              <span>联系人 {contacts.length > 0 && contacts.length}</span>
              <Button type="link" size="small" style={{ padding: 0, height: "auto" }} onClick={() => { setEditingContact(null); setContactOpen(true); }}>添加联系人</Button>
            </div>
            {contacts.length === 0 && <div className="rec-empty">还没有联系人</div>}
            {contacts.map((c) => (
              <div key={c.id} className="rec-mini">
                <Avatar size={26} style={{ background: avatarColor(c.name), color: AVATAR_TEXT, fontSize: 12 }}>{initial(c.name)}</Avatar>
                <span className="rec-mini-n">
                  {c.name}
                  {c.isPrimary && <Tag color="blue" style={{ marginLeft: 6, borderRadius: 6, fontSize: 11, lineHeight: "16px", padding: "0 5px" }}>关键</Tag>}
                </span>
                <span className="rec-mini-m">{c.position ?? c.phone ?? ""}</span>
                <Button type="text" size="small" icon={<EditOutlined />} onClick={() => { setEditingContact(c); setContactOpen(true); }} />
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() =>
                    modal.confirm({
                      title: `删除联系人「${c.name}」？`,
                      okText: "删除",
                      okButtonProps: { danger: true },
                      cancelText: "取消",
                      async onOk() {
                        await deleteContact(c.id);
                        router.refresh();
                      },
                    })
                  }
                />
              </div>
            ))}
          </div>

          <div className="rec-sec">
            <div className="rec-sec-t">
              <span>商机 {opportunities.length > 0 && opportunities.length}</span>
              <Link href="/opportunities">全部 ›</Link>
            </div>
            {opportunities.length === 0 && <div className="rec-empty">还没有商机</div>}
            {opportunities.map((o) => (
              <Link key={o.id} href={`/opportunities?keyword=${encodeURIComponent(o.name)}`} className="rec-mini">
                <span className="rec-mini-n">{o.name}</span>
                <StageTag stage={o.stage} />
                <span className="rec-mini-m">{money(o.amount)}</span>
              </Link>
            ))}
          </div>

          <div className="rec-sec">
            <div className="rec-sec-t">
              <span>签约 {contracts.length > 0 && contracts.length}</span>
              <Button type="link" size="small" style={{ padding: 0, height: "auto" }} onClick={() => { setEditingContract(null); setContractOpen(true); }}>登记签约</Button>
            </div>
            {contracts.length === 0 && <div className="rec-empty">还没有签约</div>}
            {contracts.map((c) => (
              <div key={c.id} className="rec-mini">
                <DollarOutlined style={{ color: "#16a34a" }} />
                <span className="rec-mini-n" style={{ fontWeight: 600 }}>{money(c.amount)}</span>
                <span className="rec-mini-m">{fmtDate(c.signedAt)}</span>
                <Button type="text" size="small" icon={<EditOutlined />} onClick={() => { setEditingContract(c); setContractOpen(true); }} />
                <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => confirmDeleteContract(c)} />
              </div>
            ))}
          </div>
        </aside>

        {/* ================= 中栏：时间线 ================= */}
        <section className="rec-col rec-card">
          <div className="rec-composer">
            <Input.TextArea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              autoSize={{ minRows: 2, maxRows: 8 }}
              maxLength={5000}
              placeholder={aiEnabled ? `记一笔，或直接粘贴和${b.customer}的微信聊天记录…` : "记一笔…"}
            />
            <div className="rec-composer-bar">
              <span className="rec-composer-hint">
                {aiEnabled ? "「AI 解析」会把它整理成跟进记录并留存原文；「直接记」原样存为一条记录" : "Enter 换行，写完点「直接记」"}
              </span>
              {aiEnabled && (
                <Button size="small" type="primary" ghost icon={<ThunderboltOutlined />} disabled={memo.trim().length < 5} onClick={() => openFollow(null, memo)}>
                  AI 解析
                </Button>
              )}
              <Button size="small" loading={quickSaving} disabled={!memo.trim()} onClick={() => void quickSave()}>
                直接记
              </Button>
            </div>
          </div>

          {plan && (
            <div className="rec-plan">
              <span className="rec-plan-k">下次跟进</span>
              <span className="rec-plan-v">
                {plan.subject} · {plan.method}
              </span>
              <span className="rec-plan-m">{fmtDateTime(plan.plannedAt)}</span>
              <Button size="small" type="text" onClick={() => setPlanOpen(true)}>
                改
              </Button>
              <Button
                size="small"
                type="text"
                icon={<CheckCircleOutlined />}
                onClick={async () => {
                  await completePlan(plan.id);
                  message.success("计划已完成");
                  router.refresh();
                }}
              >
                完成
              </Button>
            </div>
          )}

          <div className="rec-filters">
            {["全部", ...FOLLOW_TYPES.map((t) => t.value), "CONTRACT"].map((k) => {
              const label = k === "全部" ? "全部" : k === "CONTRACT" ? "签约" : FOLLOW_TYPE_MAP[k]?.label ?? k;
              return (
                <span key={k} className={`rec-chip${filter === k ? " rec-chip-on" : ""}`} onClick={() => setFilter(k)}>
                  {label}
                </span>
              );
            })}
          </div>

          <div className="rec-tl">
            {entries.length === 0 && (
              <div style={{ padding: "36px 0", textAlign: "center", color: "#94a3b8" }}>
                {filter === "全部" ? "还没有任何记录。上面随手记一笔，或粘一段聊天记录让 AI 整理。" : "这个类型下还没有记录"}
              </div>
            )}
            <AnimatePresence initial={false}>
              {entries.map((e, i) =>
                e.kind === "contract" ? (
                  <motion.div key={`c-${e.c.id}`} className="rec-tl-item" layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ delay: Math.min(i, 8) * 0.03 }}>
                    <div className="rec-tl-dot" style={{ background: "#16a34a" }}>
                      <DollarOutlined />
                    </div>
                    <div className="rec-tl-body">
                      <div className="rec-tl-contract">
                        <div className="rec-tl-head">
                          <span className="rec-tl-type">签约 {money(e.c.amount)}</span>
                          {e.c.remark && <span className="rec-tl-title">· {e.c.remark}</span>}
                          <span className="rec-tl-time">{fmtDate(e.c.signedAt)}</span>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ) : (
                  <FollowItem key={e.f.id} f={e.f} index={i} onEdit={() => openFollow(e.f)} onDelete={() => confirmDeleteFollow(e.f)} />
                ),
              )}
            </AnimatePresence>
          </div>
        </section>

        {/* ================= 右栏：AI + 计划/待办 ================= */}
        <aside className="rec-right rec-rail">
          <Space orientation="vertical" size={14} style={{ width: "100%" }}>
            {aiEnabled && (
              <div className="rec-card">
                <AiPanel customerId={customer.id} customerName={customer.name} fingerprint={fingerprint} signed={customer.followStatus === "已签约"} hasRecords={followUps.length > 0} />
              </div>
            )}

            <div className="rec-card rec-side-card">
              <div className="rec-side-t">
                <span>待办 {openTasks.length > 0 && openTasks.length}</span>
                <Button type="link" size="small" style={{ padding: 0, height: "auto", fontWeight: 400 }} icon={<PlusOutlined />} onClick={() => setTaskOpen(true)}>
                  新建任务
                </Button>
              </div>
              {openTasks.length === 0 && <Typography.Text type="secondary" style={{ fontSize: 13 }}>暂无待办</Typography.Text>}
              {openTasks.map((t) => (
                <div key={t.id} className="rec-task">
                  <Checkbox
                    checked={t.done}
                    onChange={async (e) => {
                      await toggleTask(t.id, e.target.checked);
                      router.refresh();
                    }}
                  />
                  <span>{t.title}</span>
                  <span className="rec-task-due" style={{ color: t.dueAt && dayjs(t.dueAt).isBefore(dayjs()) ? "#dc2626" : undefined }}>
                    {smartTime(t.dueAt)}
                  </span>
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={async () => { await deleteTask(t.id); router.refresh(); }} />
                </div>
              ))}
            </div>

            {!plan && (
              <div className="rec-card rec-side-card">
                <div className="rec-side-t">
                  <span>下次跟进</span>
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>尚未安排</Typography.Text>
                <Button block style={{ marginTop: 10 }} onClick={() => setPlanOpen(true)}>
                  制定跟进计划
                </Button>
              </div>
            )}
          </Space>
        </aside>
      </div>

      {/* 弹窗：新建/编辑跟进仍用完整表单（字段多），其余小表单也保留 */}
      <FollowUpForm
        open={followOpen}
        onClose={() => setFollowOpen(false)}
        onSaved={() => {
          setFollowOpen(false);
          setMemo("");
          router.refresh();
        }}
        customerId={customer.id}
        record={followInit.record}
        initialAiText={followInit.aiText}
        contacts={contacts}
        opportunities={opportunities}
        aiEnabled={aiEnabled}
      />
      <TaskForm open={taskOpen} onClose={() => setTaskOpen(false)} onSaved={() => { setTaskOpen(false); router.refresh(); }} customerId={customer.id} />
      <PlanForm open={planOpen} onClose={() => setPlanOpen(false)} onSaved={() => { setPlanOpen(false); router.refresh(); }} customerId={customer.id} record={plan} />
      <ContactForm open={contactOpen} onClose={() => setContactOpen(false)} onSaved={() => { setContactOpen(false); router.refresh(); }} customerId={customer.id} record={editingContact} />
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

  function confirmDeleteFollow(f: FollowUpRow) {
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
    });
  }

  function confirmDeleteContract(r: ContractRow) {
    const 是最后一笔 = contracts.length === 1;
    modal.confirm({
      title: "删除这条签约记录？",
      content: !是最后一笔 ? (
        `金额 ${money(r.amount)}，删除后统计数据会同步变化。`
      ) : (
        <>
          <div>
            金额 {money(r.amount)}。这是该{b.customer}唯一一笔签约，删除后签约金额归零，跟进状态需要跟着退回，否则看板上会一直挂着「已签约、金额 0」。
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ marginBottom: 6, fontSize: 13 }}>跟进状态退回到：</div>
            <Select
              style={{ width: "100%" }}
              defaultValue={revertChoice.current}
              onChange={(v) => (revertChoice.current = v)}
              options={[...REVERT_CHOICES.map((c) => ({ value: c.value, label: c.label })), { value: "", label: "保持「已签约」不变（我知道自己在做什么）" }]}
            />
          </div>
        </>
      ),
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        const picked = REVERT_CHOICES.find((c) => c.value === revertChoice.current);
        const res = await deleteContract(r.id, customer.id, 是最后一笔 && picked ? { followStatus: picked.value, decisionStatus: picked.decision } : null);
        router.refresh();
        if (!res.ok) {
          message.error(res.error);
          return;
        }
        message.success(是最后一笔 && picked ? `已删除，跟进状态已退回「${picked.value}」` : "已删除");
      },
    });
  }
}

/** 状态标签：点一下弹出下拉直接改，改完 Tag 过渡到新颜色 */
function StatusPicker({
  customerId,
  field,
  value,
  options,
  children,
}: {
  customerId: string;
  field: "followStatus" | "decisionStatus";
  value: string;
  options: { value: string; label: string }[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  return (
    <Dropdown
      trigger={["click"]}
      menu={{
        selectedKeys: [value],
        items: options.map((o) => ({ key: o.value, label: o.label })),
        onClick: async ({ key }) => {
          if (key === value) return;
          setSaving(true);
          const { patchCustomer } = await import("../actions");
          const res = await patchCustomer(customerId, field, key);
          setSaving(false);
          if (!res.ok) message.error(res.error);
          else router.refresh();
        },
      }}
    >
      <motion.span style={{ cursor: "pointer", display: "inline-flex", opacity: saving ? 0.5 : 1 }} whileTap={{ scale: 0.96 }} layout>
        {children}
      </motion.span>
    </Dropdown>
  );
}

function FollowItem({ f, index, onEdit, onDelete }: { f: FollowUpRow; index: number; onEdit: () => void; onDelete: () => void }) {
  const meta = FOLLOW_TYPE_MAP[f.type] ?? FOLLOW_TYPE_MAP.OTHER;
  const [srcOpen, setSrcOpen] = useState(false);
  return (
    <motion.div className="rec-tl-item" layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ delay: Math.min(index, 8) * 0.03 }}>
      <div className="rec-tl-dot" style={{ background: meta.color }}>
        {TYPE_ICON[f.type]}
      </div>
      <div className="rec-tl-body">
        <div className="rec-tl-head">
          <span className="rec-tl-type">{meta.label}</span>
          {f.title?.trim() && <span className="rec-tl-title">· {f.title}</span>}
          {f.status !== "已完成" && (
            <Tag color={FOLLOW_RECORD_STATUS_COLOR[f.status] ?? "default"} style={{ margin: 0, borderRadius: 6 }}>
              {f.status}
            </Tag>
          )}
          <span className="rec-tl-time">{fmtDateTime(f.occurredAt)}</span>
          <span className="rec-tl-acts">
            <Button type="text" size="small" icon={<EditOutlined />} onClick={onEdit} aria-label="编辑跟进" />
            <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={onDelete} aria-label="删除跟进" />
          </span>
        </div>
        <div className="rec-tl-content">{f.content}</div>
        {f.sourceText && (
          <div style={{ marginTop: 2 }}>
            <Typography.Link style={{ fontSize: 12, color: "#94a3b8" }} onClick={() => setSrcOpen((v) => !v)}>
              {srcOpen ? "收起原文" : "查看原文"}
            </Typography.Link>
            <AnimatePresence>
              {srcOpen && (
                <motion.pre
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  style={{
                    marginTop: 6, marginBottom: 0, padding: "10px 12px", background: "#f8fafc", border: "1px solid #eef2f7",
                    borderRadius: 8, fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word",
                    fontFamily: "inherit", color: "#475569", maxHeight: 320, overflow: "auto",
                  }}
                >
                  {f.sourceText}
                </motion.pre>
              )}
            </AnimatePresence>
          </div>
        )}
        <div className="rec-tl-meta">
          {f.duration ? <span>时长 {duration(f.duration)}</span> : null}
          {f.contactName && <span>{f.contactName}{f.contactPosition ? `（${f.contactPosition}）` : ""}</span>}
          {f.participants && <span>参与人：{f.participants}</span>}
          {f.dueAt && <span>截止 {fmtDateTime(f.dueAt)}</span>}
          <span style={{ marginLeft: "auto" }}>{f.ownerName}</span>
        </div>
      </div>
    </motion.div>
  );
}
