"use client";

import { useState } from "react";
import Link from "next/link";
import { App, Select, Input, DatePicker } from "antd";
import { CheckOutlined, CloseOutlined, RightOutlined } from "@ant-design/icons";
import { motion } from "motion/react";
import { applyProposal } from "@/app/(app)/dashboard/apply";
import { describeProposal, missingFields, type Proposal } from "@/lib/agent/proposals";
import { useBusiness } from "@/lib/business-client";
import { statusLabel } from "@/lib/business-config";
import { FOLLOW_TYPES, FOLLOW_METHODS, FOLLOW_STATUSES, DECISION_STATUSES, LEAD_STATUSES } from "@/lib/constants";
import { dayjs } from "@/lib/utils";

/**
 * AI 建议卡：唯一一条让模型的输出进到数据库的路。
 *
 * 四种形态（改状态 / 记一条跟进 / 排一次计划 / 新建线索），共用一套骨架：
 *   抬头一句话说清要改什么 → 字段就地可改 → 确认 / 忽略
 *
 * 它同时是一张表单：模型不知道的字段就留空，人在卡片上补，而不是被要求
 * 回到对话里照格式打一遍字。缺必填项时「确认」是灰的，旁边写明还差什么。
 * 确认之前什么都没发生；确认之后卡片塌成一行绿字，不留按钮，避免重复点。
 * 人改过的值不在这里判对错，服务端会用生成时同一套校验再收一遍。
 */
export default function ProposalCard({ proposal }: { proposal: Proposal }) {
  const b = useBusiness();
  const { message } = App.useApp();
  const [draft, setDraft] = useState<Proposal>(proposal);
  const [state, setState] = useState<"idle" | "saving" | "done" | "denied">("idle");
  const [err, setErr] = useState("");
  // 模型不知道的字段留空，人在卡片上补齐才能确认
  const missing = missingFields(draft);

  async function confirm() {
    setState("saving");
    setErr("");
    const r = await applyProposal(draft);
    if (r.ok) {
      setState("done");
      message.success(r.message);
    } else {
      setState("idle");
      setErr(r.error);
    }
  }

  if (state === "denied") return null;

  if (state === "done") {
    return (
      <motion.div className="prop prop-done" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <CheckOutlined />
        <span>{describeProposal(draft, b.customer)}</span>
        <Link href={draft.kind === "add_lead" ? "/leads" : `/customers/${draft.customerId}`} className="cli-link">
          查看 <RightOutlined style={{ fontSize: 10 }} />
        </Link>
      </motion.div>
    );
  }

  return (
    <motion.div className="prop" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
      <div className="prop-h">
        <span className="prop-tag">建议</span>
        <span className="prop-t">{describeProposal(draft, b.customer)}</span>
      </div>
      <div className="prop-why">{draft.reason}</div>

      <div className="prop-body">
        {draft.kind === "set_status" && (
          <Field label={draft.field === "followStatus" ? "改成" : "决策状态"}>
            <Select
              size="small"
              style={{ width: 160 }}
              placeholder="选一个"
              value={draft.to || undefined}
              options={(draft.field === "followStatus" ? FOLLOW_STATUSES : DECISION_STATUSES).map((v) => ({ value: v, label: statusLabel(b, v) }))}
              onChange={(v) => setDraft({ ...draft, to: v })}
            />
          </Field>
        )}

        {draft.kind === "add_followup" && (
          <>
            <Field label="类型">
              <Select
                size="small"
                style={{ width: 160 }}
                value={draft.type}
                options={FOLLOW_TYPES.map((t) => ({ value: t.value, label: t.label }))}
                onChange={(v) => setDraft({ ...draft, type: v })}
              />
            </Field>
            <Field label="时间">
              <DatePicker
                size="small"
                showTime={{ format: "HH:mm" }}
                format="MM-DD HH:mm"
                allowClear={false}
                value={dayjs(draft.occurredAt)}
                onChange={(d) => d && setDraft({ ...draft, occurredAt: d.toISOString() })}
              />
            </Field>
            <Field label="内容" block>
              <Input.TextArea
                size="small"
                autoSize={{ minRows: 2, maxRows: 8 }}
                value={draft.content}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              />
            </Field>
          </>
        )}

        {draft.kind === "add_plan" && (
          <>
            <Field label="时间">
              <DatePicker
                size="small"
                showTime={{ format: "HH:mm" }}
                format="MM-DD HH:mm"
                allowClear={false}
                placeholder="选个时间"
                value={draft.plannedAt ? dayjs(draft.plannedAt) : null}
                onChange={(d) => d && setDraft({ ...draft, plannedAt: d.toISOString() })}
              />
            </Field>
            <Field label="方式">
              <Select
                size="small"
                style={{ width: 140 }}
                placeholder="选一种"
                value={draft.method || undefined}
                options={FOLLOW_METHODS.map((v) => ({ value: v, label: v }))}
                onChange={(v) => setDraft({ ...draft, method: v })}
              />
            </Field>
            <Field label="谈什么" block>
              <Input size="small" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
            </Field>
          </>
        )}

        {draft.kind === "add_lead" && (
          <>
            <Field label="名称">
              <Input size="small" style={{ width: 160 }} placeholder="姓名或公司名" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="联系人">
              <Input size="small" style={{ width: 140 }} placeholder="可留空" value={draft.contact} onChange={(e) => setDraft({ ...draft, contact: e.target.value })} />
            </Field>
            <Field label="电话">
              <Input size="small" style={{ width: 150 }} placeholder="可留空" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
            </Field>
            <Field label="来源">
              <Select
                size="small"
                style={{ width: 130 }}
                value={draft.source}
                options={b.sources.map((v) => ({ value: v, label: v }))}
                onChange={(v) => setDraft({ ...draft, source: v })}
              />
            </Field>
            <Field label="状态">
              <Select
                size="small"
                style={{ width: 120 }}
                value={draft.status}
                options={LEAD_STATUSES.map((v) => ({ value: v, label: v }))}
                onChange={(v) => setDraft({ ...draft, status: v })}
              />
            </Field>
            <Field label="备注" block>
              <Input.TextArea size="small" autoSize={{ minRows: 1, maxRows: 5 }} placeholder="可留空" value={draft.remark} onChange={(e) => setDraft({ ...draft, remark: e.target.value })} />
            </Field>
          </>
        )}
      </div>

      {err && <div className="prop-err">{err}</div>}

      <div className="prop-foot">
        <button type="button" className="prop-ok" onClick={confirm} disabled={state === "saving" || missing.length > 0}>
          <CheckOutlined /> {state === "saving" ? "写入中…" : "确认"}
        </button>
        <button type="button" className="prop-no" onClick={() => setState("denied")} disabled={state === "saving"}>
          <CloseOutlined /> 忽略
        </button>
        <span className="prop-note">{missing.length ? `还差${missing.join("、")}` : "确认前不会写入任何数据"}</span>
      </div>
    </motion.div>
  );
}

function Field({ label, children, block }: { label: string; children: React.ReactNode; block?: boolean }) {
  return (
    <div className={`prop-f${block ? " prop-f-block" : ""}`}>
      <span className="prop-f-l">{label}</span>
      {children}
    </div>
  );
}
