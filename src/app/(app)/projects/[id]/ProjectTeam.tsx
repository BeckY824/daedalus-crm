"use client";

import { useState } from "react";
import { Button, Card, Input, InputNumber, Modal, Popconfirm, Select, Space, Tag } from "antd";
import { 币种选项 } from "@/lib/currency";
import { 金额格式 } from "@/lib/money-input";
import { 成员选项, 独自一人, type 可选成员 } from "@/lib/utils";
import { 项目名上限, 备注上限 } from "@/lib/project/wizard";
import { 编辑项目, 加项目组员, 换项目组员角色, 移出项目组员 } from "../actions";

type 跑法 = (f: () => Promise<{ ok: boolean; error?: string }>, 成了?: string) => Promise<boolean>;
export type 组员 = { id: string; userId: string; name: string; roleId: string | null; inviteStatus: string };
export type 角色 = { id: string; name: string; active: boolean };
export type 联系人 = { id: string; name: string; position: string | null };

/** 停用的角色不让新选；已经用着它的组员照样显示名字 */
function 角色选项(角色们: 角色[], 现在?: string | null) {
  return 角色们.filter((r) => r.active || r.id === 现在).map((r) => ({ value: r.id, label: r.active ? r.name : `${r.name}（已停用）` }));
}

const 邀请说法: Record<string, string> = { INVITED: "已邀请", DECLINED: "没接受" };

/**
 * 编辑项目：名称、负责人、金额 + 币种、备注、主联系人。规矩和建档向导第四步一样（服务端 规整项目）
 */
export function ProjectEditModal({
  open, onClose, 跑, p, 候选, 联系人们,
}: {
  open: boolean;
  onClose: () => void;
  跑: 跑法;
  p: { id: string; name: string; ownerId: string; amount: number; currency: string; remark: string | null; contactId: string | null };
  候选: 可选成员[];
  联系人们: 联系人[];
}) {
  // 父组件每次打开时才挂上，初值就是最新的
  const [d, setD] = useState({ name: p.name, ownerId: p.ownerId, amount: p.amount, currency: p.currency, remark: p.remark ?? "", contactId: p.contactId });
  const [忙, set忙] = useState(false);
  const 改 = (x: Partial<typeof d>) => setD((o) => ({ ...o, ...x }));
  const 行 = (label: string, el: React.ReactNode) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ marginBottom: 4, color: "var(--text-muted)" }}>{label}</div>
      {el}
    </div>
  );
  return (
    <Modal
      open={open}
      title="编辑项目"
      okText="保存"
      okButtonProps={{ loading: 忙, disabled: !d.name.trim() }}
      onCancel={onClose}
      onOk={async () => {
        set忙(true);
        const ok = await 跑(() => 编辑项目(p.id, { ...d, amount: d.amount ?? 0 }), "已保存");
        set忙(false);
        if (ok) onClose();
      }}
    >
      {行("项目名称", <Input value={d.name} maxLength={项目名上限} showCount onChange={(e) => 改({ name: e.target.value })} />)}
      {!独自一人(候选, d.ownerId) && 行("负责人", (
        <Select style={{ width: "100%" }} value={d.ownerId} options={成员选项(候选)} onChange={(v) => 改({ ownerId: v })} />
      ))}
      {行("主联系人", (
        <Select
          style={{ width: "100%" }}
          allowClear
          placeholder="不填"
          value={d.contactId ?? undefined}
          options={联系人们.map((c) => ({ value: c.id, label: c.position ? `${c.name} · ${c.position}` : c.name }))}
          onChange={(v) => 改({ contactId: v ?? null })}
        />
      ))}
      {行("金额", (
        <Space.Compact style={{ width: "100%" }}>
          <Select style={{ width: 140 }} value={d.currency} options={币种选项()} onChange={(v) => 改({ currency: v })} showSearch optionFilterProp="label" />
          <InputNumber<number> style={{ width: "100%" }} min={0} value={d.amount} formatter={金额格式} onChange={(v) => 改({ amount: v ?? 0 })} />
        </Space.Compact>
      ))}
      {行("备注", <Input.TextArea rows={3} maxLength={备注上限} showCount value={d.remark} onChange={(e) => 改({ remark: e.target.value })} />)}
    </Modal>
  );
}

/**
 * 项目组：谁在组里、各自什么角色。能管项目的人加人、换角色、移出；团队版拉进来就算进组。
 * 企业版（10-26）= 发邀请，对方在项目列表上点同意才进组；没接受的可以再邀一次；组长 = 项目负责人
 */
export function ProjectTeamCard({
  projectId, 组员们, 角色们, 在职, 能改, 忙, 跑, 企业版 = false, 组长,
}: {
  projectId: string;
  组员们: 组员[];
  角色们: 角色[];
  在职: 可选成员[];
  能改: boolean;
  忙: boolean;
  跑: 跑法;
  企业版?: boolean;
  组长?: string;
}) {
  const [加谁, set加谁] = useState<string | undefined>();
  const [加角色, set加角色] = useState<string | undefined>();
  const 在组 = new Set(组员们.filter((m) => !(企业版 && m.inviteStatus === "DECLINED")).map((m) => m.userId));
  const 可加 = 在职.filter((u) => !在组.has(u.id));
  const 不能改 = 能改 ? undefined : "只有项目负责人、老板或主管能改";

  return (
    <Card title="项目组">
      {企业版 && 组长 && <div style={{ marginBottom: 8 }}>组长：{组长}</div>}
      {组员们.length === 0 && <div style={{ color: "var(--text-muted)", marginBottom: 8 }}>还没有拉人进项目组</div>}
      {组员们.map((m) => (
        <div key={m.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, minWidth: 0 }}>
          <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={m.name}>{m.name}</span>
          {邀请说法[m.inviteStatus] && <Tag>{邀请说法[m.inviteStatus]}</Tag>}
          <Select
            style={{ width: 140, flex: "0 0 auto" }}
            size="small"
            allowClear
            placeholder="不填角色"
            aria-label={`${m.name}的角色`}
            disabled={!能改 || 忙}
            title={不能改}
            value={m.roleId ?? undefined}
            options={角色选项(角色们, m.roleId)}
            onChange={(v) => void 跑(() => 换项目组员角色(m.id, v ?? null))}
          />
          {能改 && (
            <Popconfirm title={`把${m.name}移出项目组？`} okText="移出" okButtonProps={{ danger: true }} onConfirm={() => void 跑(() => 移出项目组员(m.id), "已移出")}>
              <Button size="small" type="text" danger disabled={忙}>移出</Button>
            </Popconfirm>
          )}
        </div>
      ))}
      {能改 && (
        <Space.Compact style={{ width: "100%", marginTop: 4 }}>
          <Select
            style={{ flex: "1 1 auto", minWidth: 0 }}
            placeholder={可加.length ? "选一位成员" : "在职成员都在组里了"}
            aria-label="要加进项目组的成员"
            disabled={!可加.length || 忙}
            showSearch
            optionFilterProp="label"
            value={加谁}
            options={成员选项(可加)}
            onChange={set加谁}
          />
          <Select style={{ width: 120 }} allowClear placeholder="角色" aria-label="新组员的角色" disabled={忙} value={加角色} options={角色选项(角色们)} onChange={set加角色} />
          <Button
            disabled={!加谁 || 忙}
            onClick={async () => {
              if (!加谁) return;
              if (await 跑(() => 加项目组员(projectId, 加谁, 加角色 ?? null), 企业版 ? "已发邀请，等对方同意" : "已加进项目组")) {
                set加谁(undefined);
                set加角色(undefined);
              }
            }}
          >
            {企业版 ? "邀请" : "加进来"}
          </Button>
        </Space.Compact>
      )}
    </Card>
  );
}
