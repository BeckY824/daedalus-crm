"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { App, Button, Card, Input, InputNumber, Modal, Select, Space, Tag, Timeline } from "antd";
import { dayjs, fmtDateTime } from "@/lib/utils";
import type { 卡点卡 } from "@/lib/project/blocker";
import { 卡点类型们, 影响等级们, 动作叫法, 描述上限, 理由上限, 时限最大, type 卡点默认 } from "@/lib/project/blocker-rules";
import {
  发布卡点Action, 指认卡点Action, 认领卡点Action, 接受卡点Action, 转让卡点Action, 返回卡点Action, 改卡点进度Action, 解决卡点Action, 卡点可选的人Action,
} from "./blocker-actions";

export type { 卡点卡 };
export type 可选人 = { id: string; name: string };

type 结果 = { ok: boolean; error?: string };

/** 跑一个卡点动作：报错弹出来、成了刷新页面 */
function useRun() {
  const router = useRouter();
  const { message } = App.useApp();
  const [忙, set忙] = useState(false);
  const 跑 = async (f: () => Promise<结果>, 成了: string) => {
    set忙(true);
    try {
      const r = await f();
      if (!r.ok) message.error(r.error ?? "没改成，请稍后再试");
      else {
        message.success(成了);
        router.refresh();
      }
      return r.ok;
    } catch {
      message.error("没改成，请稍后再试");
      return false;
    } finally {
      set忙(false);
    }
  };
  return { 忙, 跑 };
}

const 状态色: Record<string, string> = { 看板: "orange", 待接受: "gold", 处理中: "blue", 已解决: "green" };
const 类型色: Record<string, string> = { 暂无卡点: "default", 轻度卡点: "cyan", 中度卡点: "orange", 重要卡点: "red" };

/** 流转一行：「张三 转让 · 张三 → 李四」 */
function 流转文字(l: 卡点卡["流转"][number]): string {
  const 叫 = 动作叫法[l.action] ?? l.action;
  const 路 = l.从 && l.到 ? `${l.从} → ${l.到}` : l.到 ? `给 ${l.到}` : "";
  return [`${l.谁} ${叫}`, 路].filter(Boolean).join(" · ");
}

/** 过期没解决：时限是 dueAt */
function 过期(b: 卡点卡): boolean {
  return b.status !== "已解决" && dayjs(b.dueAt).isBefore(dayjs());
}

/**
 * 从一条沟通记录发布卡点：类型、影响、阻碍主体（单选，选项是老板在设置里配的）、描述、解决时限（不填按类型的默认天数）、
 * 资源申请，可以直接指认给项目上的一个人（不指 = 进看板等人认领）
 */
export function PublishBlockerModal({ followUpId, 默认, 人们, onClose }: { followUpId: string; 默认: 卡点默认; 人们: 可选人[]; onClose: () => void }) {
  const { 忙, 跑 } = useRun();
  const [type, setType] = useState<string>(默认.默认类型);
  const [impact, setImpact] = useState<string>(默认.默认影响);
  const [obstacle, setObstacle] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [dueDays, setDueDays] = useState<number | null>(null);
  const [resourceRequest, setResourceRequest] = useState("");
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const 默认天 = 默认.时限天数[type as keyof 卡点默认["时限天数"]];
  const 差 = !obstacle ? "选一个阻碍主体" : !description.trim() ? "写一句卡在哪" : "";
  return (
    <Modal
      open
      title="发布卡点"
      okText="发布"
      okButtonProps={{ disabled: !!差, loading: 忙 }}
      onCancel={onClose}
      onOk={async () => {
        if (差) return;
        const ok = await 跑(
          () => 发布卡点Action(followUpId, { type, impact, obstacle, description, dueDays: dueDays ?? undefined, resourceRequest }, assigneeId),
          assigneeId ? "已发布，等对方接受" : "已发布到卡点看板",
        );
        if (ok) onClose();
      }}
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Select aria-label="卡点类型" value={type} onChange={(v: string) => setType(v)} options={卡点类型们.map((t) => ({ value: t, label: t }))} />
        <Select aria-label="影响等级" value={impact} onChange={(v: string) => setImpact(v)} options={影响等级们.map((t) => ({ value: t, label: t }))} />
        <Select aria-label="阻碍主体" placeholder="阻碍主体" value={obstacle} onChange={(v: string) => setObstacle(v)} options={默认.阻碍主体们.map((t) => ({ value: t, label: t }))} />
        <Input.TextArea aria-label="卡点描述" rows={3} maxLength={描述上限} showCount value={description} onChange={(e) => setDescription(e.target.value)} placeholder="卡在哪（必填）" />
        <InputNumber
          aria-label="解决时限"
          style={{ width: "100%" }}
          min={1}
          max={时限最大}
          precision={0}
          value={dueDays}
          onChange={(v) => setDueDays(typeof v === "number" ? v : null)}
          placeholder={`解决时限（天），不填按${type}默认 ${默认天} 天`}
          addonAfter="天"
        />
        <Input.TextArea aria-label="资源申请" rows={2} maxLength={描述上限} value={resourceRequest} onChange={(e) => setResourceRequest(e.target.value)} placeholder="需要什么资源（可不写）" />
        <Select
          aria-label="指认给"
          allowClear
          placeholder="指认给谁（不选 = 放到卡点看板等人认领）"
          value={assigneeId}
          onChange={(v: string | undefined) => setAssigneeId(v ?? null)}
          options={人们.map((u) => ({ value: u.id, label: u.name }))}
        />
      </Space>
    </Modal>
  );
}

type 框 = { kind: "指认" | "转让" | "返回" | "进度" | "解决"; b: 卡点卡 } | null;

/**
 * 一串卡点：每条显示编号、状态、类型、影响、阻碍主体、时限、经手人，按 能 给按钮；流转（谁、什么时候、从谁到谁）展开看。
 * 项目详情和「我的卡点」看板共用；带项目名 = 看板上用（点了进项目）
 */
export function BlockerList({ 们, 人们, 带项目 = false, 空 = "还没有卡点" }: { 们: 卡点卡[]; 人们?: 可选人[] | ((projectId: string) => Promise<可选人[]>); 带项目?: boolean; 空?: string }) {
  const { 忙, 跑 } = useRun();
  const [框, set框] = useState<框>(null);
  const [人, set人] = useState<string | null>(null);
  const [字, set字] = useState("");
  const [字2, set字2] = useState("");
  const [候选, set候选] = useState<可选人[]>([]);
  const [展开, set展开] = useState<Set<string>>(new Set());

  const 打开 = async (kind: NonNullable<框>["kind"], b: 卡点卡) => {
    set人(null);
    set字(kind === "进度" ? b.progress ?? "" : "");
    set字2(kind === "进度" ? b.resourceRequest ?? "" : "");
    set框({ kind, b });
    if (kind === "指认" || kind === "转让") set候选(typeof 人们 === "function" ? await 人们(b.projectId) : 人们 ?? []);
  };
  const 关 = () => set框(null);
  const 确定 = async () => {
    if (!框) return;
    const { kind, b } = 框;
    let ok = false;
    if (kind === "指认" && 人) ok = await 跑(() => 指认卡点Action(b.id, 人), "已指认，等对方接受");
    if (kind === "转让" && 人) ok = await 跑(() => 转让卡点Action(b.id, 人, 字), "已转让，等对方接受");
    if (kind === "返回" && 字.trim()) ok = await 跑(() => 返回卡点Action(b.id, 字), "已返回卡点看板");
    if (kind === "进度") ok = await 跑(() => 改卡点进度Action(b.id, { progress: 字, resourceRequest: 字2 }), "已更新处理进度");
    if (kind === "解决") ok = await 跑(() => 解决卡点Action(b.id, { solution: 字, result: 字2 }), "卡点已解决");
    if (ok) 关();
  };
  const 候选们 = 框?.kind === "转让" ? 候选.filter((u) => u.name !== 框.b.经手人) : 候选;
  const 不能确定 = !框 ? true : 框.kind === "指认" || 框.kind === "转让" ? !人 : 框.kind === "返回" ? !字.trim() : false;

  if (!们.length) return <div style={{ color: "var(--text-muted)" }}>{空}</div>;
  return (
    <>
      {们.map((b) => (
        <div key={b.id} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid var(--line-soft)", minWidth: 0 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-muted)" }}>{b.code}</span>
            <Tag color={状态色[b.status]}>{b.status}</Tag>
            <Tag color={类型色[b.type]}>{b.type}</Tag>
            <Tag>{b.impact}</Tag>
            <Tag>{b.obstacle}</Tag>
            {带项目 && <Link href={`/projects/${b.projectId}`}>{b.项目}</Link>}
          </div>
          <div style={{ whiteSpace: "pre-wrap", marginTop: 4, overflowWrap: "anywhere" }}>{b.description}</div>
          <div style={{ color: 过期(b) ? "var(--danger-text)" : "var(--text-muted)", fontSize: 12, marginTop: 2 }}>
            {b.status === "已解决" && b.resolvedAt ? `${fmtDateTime(b.resolvedAt)} 解决` : `时限 ${b.dueDays} 天，${dayjs(b.dueAt).format("YYYY-MM-DD HH:mm")} 前${过期(b) ? "（已超时）" : ""}`}
            {" · "}{b.经手人 ? `经手 ${b.经手人}` : "看板上，没人接"}{" · "}{b.发布人} 发布
          </div>
          {b.resourceRequest && <div style={{ fontSize: 13, overflowWrap: "anywhere" }}>资源申请：{b.resourceRequest}</div>}
          {b.progress && <div style={{ fontSize: 13, overflowWrap: "anywhere" }}>处理进度：{b.progress}</div>}
          {b.solution && <div style={{ fontSize: 13, overflowWrap: "anywhere" }}>解决方案：{b.solution}</div>}
          {b.result && <div style={{ fontSize: 13, overflowWrap: "anywhere" }}>解决结果：{b.result}</div>}
          <Space wrap size={4} style={{ marginTop: 6 }}>
            {b.能.接受 && <Button size="small" type="primary" disabled={忙} onClick={() => void 跑(() => 接受卡点Action(b.id), "已接受，开始处理")}>接受</Button>}
            {b.能.认领 && <Button size="small" type="primary" disabled={忙} onClick={() => void 跑(() => 认领卡点Action(b.id), "已认领，开始处理")}>认领</Button>}
            {b.能.指认 && <Button size="small" disabled={忙} onClick={() => void 打开("指认", b)}>指认</Button>}
            {b.能.转让 && <Button size="small" disabled={忙} onClick={() => void 打开("转让", b)}>转让</Button>}
            {b.能.返回 && <Button size="small" disabled={忙} onClick={() => void 打开("返回", b)}>返回看板</Button>}
            {b.能.改进度 && <Button size="small" disabled={忙} onClick={() => void 打开("进度", b)}>更新进度</Button>}
            {b.能.解决 && <Button size="small" disabled={忙} onClick={() => void 打开("解决", b)}>标为已解决</Button>}
            <Button size="small" type="link" onClick={() => set展开((s) => { const n = new Set(s); if (n.has(b.id)) n.delete(b.id); else n.add(b.id); return n; })}>
              {展开.has(b.id) ? "收起流转" : `流转（${b.流转.length}）`}
            </Button>
          </Space>
          {展开.has(b.id) && (
            <Timeline
              style={{ marginTop: 8 }}
              items={b.流转.map((l) => ({
                color: l.action === "return" ? "orange" : l.action === "resolve" ? "green" : "blue",
                content: (
                  <div>
                    <div>{流转文字(l)}</div>
                    {l.note && <div style={{ color: "var(--text-muted)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{l.action === "return" || l.action === "transfer" || l.action === "handover" ? "理由" : "说明"}：{l.note}</div>}
                    <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{fmtDateTime(l.at)}</div>
                  </div>
                ),
              }))}
            />
          )}
        </div>
      ))}

      <Modal
        open={!!框}
        title={框 ? { 指认: "指认给谁", 转让: "转让给谁", 返回: "返回卡点看板", 进度: "更新处理进度", 解决: "标为已解决" }[框.kind] : ""}
        okText="确定"
        okButtonProps={{ disabled: 不能确定, loading: 忙 }}
        onCancel={关}
        onOk={确定}
      >
        {框 && (框.kind === "指认" || 框.kind === "转让") && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Select
              aria-label={框.kind === "指认" ? "指认给" : "转让给"}
              style={{ width: "100%" }}
              placeholder={候选们.length ? "选项目上的一位" : "项目上没有别的人可选（负责人或点了同意的组员）"}
              value={人}
              onChange={(v: string) => set人(v)}
              options={候选们.map((u) => ({ value: u.id, label: u.name }))}
            />
            {框.kind === "转让" && <Input.TextArea aria-label="转让理由" rows={2} maxLength={理由上限} value={字} onChange={(e) => set字(e.target.value)} placeholder="为什么转（可不写）" />}
            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>对方点了接受才算接手</div>
          </Space>
        )}
        {框?.kind === "返回" && (
          <>
            <div style={{ marginBottom: 8, color: "var(--text-muted)" }}>写一句为什么不接，卡点回到看板等别人认领。</div>
            <Input.TextArea aria-label="返回理由" rows={3} maxLength={理由上限} showCount value={字} onChange={(e) => set字(e.target.value)} placeholder="理由（必填）" />
          </>
        )}
        {框?.kind === "进度" && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Input.TextArea aria-label="处理进度" rows={3} maxLength={描述上限} value={字} onChange={(e) => set字(e.target.value)} placeholder="处理到哪了" />
            <Input.TextArea aria-label="资源申请" rows={2} maxLength={描述上限} value={字2} onChange={(e) => set字2(e.target.value)} placeholder="需要什么资源（可不写）" />
          </Space>
        )}
        {框?.kind === "解决" && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Input.TextArea aria-label="解决方案" rows={3} maxLength={描述上限} value={字} onChange={(e) => set字(e.target.value)} placeholder="怎么解决的" />
            <Input.TextArea aria-label="解决结果" rows={2} maxLength={描述上限} value={字2} onChange={(e) => set字2(e.target.value)} placeholder="结果怎样" />
          </Space>
        )}
      </Modal>
    </>
  );
}

/** 项目列表顶上：「我的卡点」看板（指给我的、我在项目上且没人接的），没有就不显示 */
export function MyBlockersBoard({ 们 }: { 们: 卡点卡[] }) {
  if (!们.length) return null;
  const 待 = 们.filter((b) => b.status === "待接受").length;
  return (
    <Card title={`我的卡点（${们.length}${待 ? `，${待} 条等我接受` : ""}）`} size="small" style={{ marginBottom: 16 }}>
      <BlockerList 们={们} 人们={卡点可选的人Action} 带项目 />
    </Card>
  );
}
