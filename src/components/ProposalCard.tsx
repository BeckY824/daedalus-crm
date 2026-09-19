"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { App, Select, Input, DatePicker, Checkbox } from "antd";
import { CheckOutlined, CloseOutlined, RightOutlined } from "@ant-design/icons";
import { motion } from "motion/react";
import { applyProposal } from "@/app/(app)/dashboard/apply";
import { describeProposal, missingFields, 只留选中的改动, 可改字段表, type Proposal } from "@/lib/agent/proposals";
import { useBusiness } from "@/lib/business-client";
import { statusLabel, type BusinessConfig } from "@/lib/business-config";
import { FOLLOW_TYPES, FOLLOW_METHODS, FOLLOW_STATUSES, DECISION_STATUSES, LEAD_STATUSES, OPP_STAGES } from "@/lib/constants";
import { dayjs } from "@/lib/utils";

/**
 * AI 建议卡：唯一一条让模型的输出进到数据库的路。
 *
 * 七种形态（改状态 / 改档案 / 记跟进 / 排计划 / 新建线索 / 新建商机 / 记一笔签约），
 * 共用一套骨架：
 *   抬头一句话说清要改什么 → 字段就地可改 → 确认 / 忽略
 *
 * 它同时是一张表单：模型不知道的字段就留空，人在卡片上补，而不是被要求
 * 回到对话里照格式打一遍字。缺必填项时「确认」是灰的，旁边写明还差什么。
 * 确认之前什么都没发生；确认之后卡片塌成一行绿字，不留按钮，避免重复点。
 * 人改过的值不在这里判对错，服务端会用生成时同一套校验再收一遍。
 *
 * **改档案是逐项的**（批 2，照 Codex 在线程里审改动那一套）：一张卡里建议改三个字段，
 * 原来只能整张一起确认——只想要其中一项的人只好整张忽略，再自己去档案页改。
 * 现在每一项各有一个勾，各自写清「现在是什么 → 改成什么」，
 * 底下是「确认选中 N 项」。⌘↵ 等于点它。
 */
export default function ProposalCard({ proposal }: { proposal: Proposal }) {
  const b = useBusiness();
  /* 三个档案字段叫什么、「职位」那一格有哪些选项，跟着业务配置走（通用版 vs 教培预设） */
  const 字段表 = 可改字段表(b);
  const { message } = App.useApp();
  const router = useRouter();
  const [draft, setDraft] = useState<Proposal>(proposal);
  const [state, setState] = useState<"idle" | "saving" | "done" | "denied">("idle");
  const [err, setErr] = useState("");
  /** 改档案时逐项勾选。默认全勾上——建议是它提的，人只需要否掉不想要的那几项 */
  const [勾了, set勾了] = useState<number[]>(() => (proposal.kind === "update_customer" ? proposal.changes.map((_, i) => i) : [0]));
  const 逐项 = draft.kind === "update_customer" && draft.changes.length > 1;

  /** 真正要提交的那张卡：逐项时只带勾上的那几项 */
  const 要提交的 = useMemo<Proposal>(() => 只留选中的改动(draft, 勾了), [draft, 勾了]);
  // 模型不知道的字段留空，人在卡片上补齐才能确认
  const missing = missingFields(要提交的);
  const 能确认 = state !== "saving" && missing.length === 0 && 勾了.length > 0;

  async function confirm() {
    if (!能确认) return;
    setState("saving");
    setErr("");
    const r = await applyProposal(要提交的);
    if (r.ok) {
      setState("done");
      message.success(r.message);
      /*
        **落库之后要刷这一页。**
        0.38.0 之前这张卡只出现在首页，首页没有会过期的列表，所以不刷也看不出来。
        面板提到全局之后它跟着到了每一页：在客户列表上确认「改成已签约」，
        卡片塌成一行绿字说改好了，而背后那张表还显示着旧状态——
        人要么以为没生效再点一次，要么就信了那张旧表。
        refresh 只重取服务端数据，不动这一屏的对话（那是模块级的，见 lib/home-thread.ts）。
      */
      router.refresh();
    } else {
      setState("idle");
      setErr(r.error);
    }
  }

  if (state === "denied") return null;

  if (state === "done") {
    return (
      /* 确认之后这张卡**收成一条**：从建议的高度落到一行回执。
         用 height: auto 的形变而不是直接换内容——直接换的话，下面的对话会往上跳一大截，
         人会以为自己点掉了什么东西 */
      <motion.div
        className="prop prop-done"
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: "auto" }}
        transition={{ duration: 0.26, ease: [0.33, 0.55, 0.2, 1] }}
        style={{ overflow: "hidden" }}
      >
        <CheckOutlined />
        <span>{describeProposal(draft, b.customer, 字段表)}</span>
        <Link href={draft.kind === "add_lead" ? "/leads" : draft.kind === "update_channel" ? "/channels" : `/customers/${draft.customerId}`} className="cli-link">
          查看 <RightOutlined style={{ fontSize: 10 }} />
        </Link>
      </motion.div>
    );
  }

  return (
    <motion.div
      className="prop"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      /* ⌘↵ = 点「确认」。光标在卡片里任何一个输入框时都管用——
         改完最后一个字段还要伸手去点按钮，是这张卡最烦的一下 */
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          void confirm();
        }
      }}
    >
      <div className="prop-h">
        <span className="prop-tag">建议</span>
        <span className="prop-t">{describeProposal(draft, b.customer, 字段表)}</span>
      </div>
      <div className="prop-why">{draft.reason}</div>

      <div className="prop-body">
        {draft.kind === "set_status" && (
          <Field label={draft.field === "followStatus" ? "跟进状态" : "决策状态"} 现值={现值文本(draft, draft.field, b)}>
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

        {/* 改档案：模型只写要改的那几项，每项按自己的类型渲染。
            负责人 / 渠道 / 推荐人是名字不是 id——落库时服务端解析，重名会拒绝 */}
        {draft.kind === "update_customer" &&
          draft.changes.map((chg, i) => {
            const spec = 字段表[chg.field];
            const 改这项 = (v: string) => setDraft({ ...draft, changes: draft.changes.map((c, j) => (j === i ? { ...c, value: v } : c)) });
            return (
              <Field
                key={chg.field}
                label={spec.label}
                现值={现值文本(draft, chg.field, b)}
                勾={逐项 ? { 上: 勾了.includes(i), 切: (v) => set勾了(v ? [...勾了, i] : 勾了.filter((x) => x !== i)) } : undefined}
                block={spec.kind === "text" && chg.field === "remark"}
              >
                {spec.kind === "enum" ? (
                  <Select
                    size="small"
                    style={{ width: 160 }}
                    placeholder="选一个"
                    value={chg.value || undefined}
                    options={(spec.values ?? []).map((v) => ({ value: v, label: chg.field === "grade" ? v : statusLabel(b, v) }))}
                    onChange={改这项}
                  />
                ) : spec.kind === "date" ? (
                  <DatePicker
                    size="small"
                    format="YYYY-MM-DD"
                    placeholder="选个日期"
                    value={chg.value ? dayjs(chg.value) : null}
                    onChange={(d) => 改这项(d ? d.toISOString() : "")}
                  />
                ) : chg.field === "remark" ? (
                  <Input.TextArea size="small" autoSize={{ minRows: 2, maxRows: 6 }} value={chg.value} onChange={(e) => 改这项(e.target.value)} />
                ) : (
                  <Input
                    size="small"
                    style={{ width: 220 }}
                    value={chg.value}
                    placeholder={spec.kind === "name" ? "写名字，不是编号" : ""}
                    onChange={(e) => 改这项(e.target.value)}
                  />
                )}
              </Field>
            );
          })}

        {draft.kind === "add_opportunity" && (
          <>
            <Field label="名称">
              <Input size="small" style={{ width: 220 }} value={draft.name} placeholder="这单叫什么" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="金额">
              <Input size="small" style={{ width: 120 }} prefix="¥" value={draft.amount || ""} onChange={(e) => setDraft({ ...draft, amount: Number(e.target.value.replace(/[^\d.]/g, "")) || 0 })} />
            </Field>
            <Field label="阶段">
              <Select size="small" style={{ width: 140 }} value={draft.stage} options={OPP_STAGES.map((v) => ({ value: v, label: v }))} onChange={(v) => setDraft({ ...draft, stage: v })} />
            </Field>
            <Field label="成交概率">
              <Input size="small" style={{ width: 90 }} suffix="%" value={draft.probability} onChange={(e) => setDraft({ ...draft, probability: Math.min(100, Number(e.target.value.replace(/[^\d]/g, "")) || 0) })} />
            </Field>
            <Field label="预计成交">
              <DatePicker size="small" format="YYYY-MM-DD" placeholder="可不填" value={draft.expectedDealAt ? dayjs(draft.expectedDealAt) : null} onChange={(d) => setDraft({ ...draft, expectedDealAt: d ? d.toISOString() : "" })} />
            </Field>
          </>
        )}

        {draft.kind === "add_contract" && (
          <>
            <Field label="签约金额">
              <Input size="small" style={{ width: 140 }} prefix="¥" value={draft.amount || ""} onChange={(e) => setDraft({ ...draft, amount: Number(e.target.value.replace(/[^\d.]/g, "")) || 0 })} />
            </Field>
            <Field label="签约日期">
              <DatePicker size="small" format="YYYY-MM-DD" allowClear={false} value={draft.signedAt ? dayjs(draft.signedAt) : null} onChange={(d) => d && setDraft({ ...draft, signedAt: d.toISOString() })} />
            </Field>
            <Field label="备注" block>
              <Input.TextArea size="small" autoSize={{ minRows: 1, maxRows: 4 }} value={draft.remark} onChange={(e) => setDraft({ ...draft, remark: e.target.value })} />
            </Field>
          </>
        )}

        {/* 改渠道：渠道负责人只存在于渠道上，客户档案里没有这个字段 */}
        {draft.kind === "update_channel" && (
          <>
            <Field label="渠道">
              <Input size="small" style={{ width: 200 }} value={draft.channelName} onChange={(e) => setDraft({ ...draft, channelName: e.target.value })} />
            </Field>
            <Field label="渠道负责人">
              <Input size="small" style={{ width: 160 }} value={draft.ownerName} placeholder="写姓名，不填就不改" onChange={(e) => setDraft({ ...draft, ownerName: e.target.value })} />
            </Field>
            <Field label="备注" block>
              <Input.TextArea size="small" autoSize={{ minRows: 1, maxRows: 4 }} value={draft.remark} placeholder="不填就不改" onChange={(e) => setDraft({ ...draft, remark: e.target.value })} />
            </Field>
          </>
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
        <button type="button" className="prop-ok" onClick={confirm} disabled={!能确认}>
          <CheckOutlined /> {state === "saving" ? "写入中…" : 逐项 ? `确认选中 ${勾了.length} 项` : "确认"}
        </button>
        {逐项 && (
          <button
            type="button"
            className="prop-no"
            onClick={() => set勾了(勾了.length ? [] : (draft as Extract<Proposal, { kind: "update_customer" }>).changes.map((_, i) => i))}
            disabled={state === "saving"}
          >
            {勾了.length ? "全部取消" : "全部选上"}
          </button>
        )}
        <button type="button" className="prop-no" onClick={() => setState("denied")} disabled={state === "saving"}>
          <CloseOutlined /> 忽略
        </button>
        <span className="prop-note">
          {勾了.length === 0 ? "一项都没选" : missing.length ? `还差${missing.join("、")}` : "确认前不会写入任何数据 · ⌘↵"}
        </span>
      </div>
    </motion.div>
  );
}

/**
 * 卡片上的一项。
 *
 * 有「现在是什么」就写成「现在 → 改成」——不写的话，卡片上一行「跟进状态：已签约」
 * 人无从判断这是在改还是本来就是。逐项勾选时前面还有一个勾。
 */
function Field({
  label, children, block, 现值, 勾,
}: {
  label: string;
  children: React.ReactNode;
  block?: boolean;
  现值?: string;
  勾?: { 上: boolean; 切: (v: boolean) => void };
}) {
  return (
    <div className={`prop-f${block ? " prop-f-block" : ""}${勾 ? " prop-f-pick" : ""}${勾 && !勾.上 ? " prop-f-off" : ""}`}>
      {勾 && <Checkbox checked={勾.上} onChange={(e) => 勾.切(e.target.checked)} aria-label={`要不要改${label}`} />}
      <span className="prop-f-l">{label}</span>
      {现值 !== undefined && (
        <span className="prop-f-was">
          {现值 || "空"} <span className="prop-f-arrow">→</span>
        </span>
      )}
      {children}
    </div>
  );
}

/** 这个字段现在显示成什么。状态类的要走业务配置里的叫法，不能直接摆库里存的值 */
function 现值文本(p: Proposal, field: string, b: BusinessConfig): string | undefined {
  const v = p.现值?.[field];
  if (v === undefined) return undefined;
  if (field === "followStatus" || field === "decisionStatus") return v ? statusLabel(b, v) : "";
  return v;
}
