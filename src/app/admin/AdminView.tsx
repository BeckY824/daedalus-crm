"use client";

import { useState } from "react";
import { App, Button, Popconfirm, Select, Table, Tag, Tooltip } from "antd";
import { activate, extendTrial, suspend } from "./actions";
import { PLANS, type PlanKey } from "@/lib/tenant/plans";
import { dayjs } from "@/lib/utils";

type Row = {
  id: string;
  slug: string;
  name: string;
  status: string;
  writable: boolean;
  daysLeft: number;
  createdAt: string;
  paidUntil: string | null;
  members: number;
  owner: { name: string; contact: string } | null;
  note: string | null;
};

/**
 * 运营台。功能只有三件：开通、延长试用、停用。
 * 不做成完整后台——工作区数量还在两位数的阶段，一张表加三个按钮就够，
 * 多做的每一块都要跟着业务改。
 */
export default function AdminView({ token, rows }: { token: string; rows: Row[] }) {
  const { message } = App.useApp();
  const [plan, setPlan] = useState<PlanKey>("year");
  const [busy, setBusy] = useState<string | null>(null);

  async function run(id: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(id);
    const r = await fn();
    setBusy(null);
    if (r.ok) message.success("已更新");
    else message.error(r.error ?? "操作失败");
  }

  const 待核对 = rows.filter((r) => r.note?.includes("[待核对]")).length;

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 4px" }}>工作区</h1>
      <div style={{ color: "#6b7280", fontSize: 13, marginBottom: 16 }}>
        共 {rows.length} 个，{rows.filter((r) => r.status === "TRIAL" && r.writable).length} 个在试用
        {待核对 > 0 && <span style={{ color: "#b45309" }}>，{待核对} 个待核对付款</span>}
      </div>

      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, color: "#6b7280" }}>开通用的套餐</span>
        <Select
          size="small"
          value={plan}
          style={{ width: 160 }}
          onChange={setPlan}
          options={(Object.keys(PLANS) as PlanKey[]).map((k) => ({ value: k, label: `${PLANS[k].label} ¥${PLANS[k].price}` }))}
        />
      </div>

      <Table<Row>
        rowKey="id"
        size="small"
        dataSource={rows}
        pagination={{ pageSize: 30, hideOnSinglePage: true }}
        scroll={{ x: 980 }}
        columns={[
          {
            title: "工作区",
            dataIndex: "name",
            render: (_, r) => (
              <div>
                <div style={{ fontWeight: 500 }}>{r.name}</div>
                <div style={{ fontSize: 11.5, color: "#9ca3af" }}>{r.slug}</div>
              </div>
            ),
          },
          {
            title: "创建者",
            dataIndex: "owner",
            render: (_, r) => (r.owner ? `${r.owner.name} · ${r.owner.contact}` : "—"),
          },
          { title: "成员", dataIndex: "members", width: 60 },
          {
            title: "状态",
            dataIndex: "status",
            width: 140,
            render: (_, r) => {
              if (r.status === "SUSPENDED") return <Tag color="error">已停用</Tag>;
              if (!r.writable) return <Tag color="error">已过期</Tag>;
              if (r.paidUntil) return <Tag color="success">已付费 · {r.daysLeft} 天</Tag>;
              return <Tag color={r.daysLeft <= 2 ? "warning" : "processing"}>试用 · {r.daysLeft} 天</Tag>;
            },
          },
          {
            title: "注册于",
            dataIndex: "createdAt",
            width: 110,
            render: (v: string) => dayjs(v).format("MM-DD HH:mm"),
          },
          {
            title: "备注",
            dataIndex: "note",
            render: (v: string | null) =>
              v ? (
                <Tooltip title={<span style={{ whiteSpace: "pre-wrap" }}>{v}</span>}>
                  <span style={{ color: v.includes("[待核对]") ? "#b45309" : "#6b7280", fontSize: 12 }}>
                    {v.split("\n").slice(-1)[0].slice(0, 30)}
                  </span>
                </Tooltip>
              ) : (
                <span style={{ color: "#d1d5db" }}>—</span>
              ),
          },
          {
            title: "操作",
            width: 220,
            render: (_, r) => (
              <div style={{ display: "flex", gap: 8 }}>
                <Popconfirm
                  title={`按${PLANS[plan].label} ¥${PLANS[plan].price} 开通？`}
                  onConfirm={() => run(r.id, () => activate({ token, workspaceId: r.id, plan }))}
                >
                  <Button size="small" type="primary" loading={busy === r.id}>
                    开通
                  </Button>
                </Popconfirm>
                <Button size="small" onClick={() => run(r.id, () => extendTrial({ token, workspaceId: r.id, days: 7 }))}>
                  +7 天
                </Button>
                <Button size="small" danger={r.status !== "SUSPENDED"} onClick={() => run(r.id, () => suspend({ token, workspaceId: r.id, on: r.status !== "SUSPENDED" }))}>
                  {r.status === "SUSPENDED" ? "恢复" : "停用"}
                </Button>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
