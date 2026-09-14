"use client";

import { useState } from "react";
import { App, Alert, Button, Form, Input, Modal, Popconfirm, Select, Table, Tag, Tooltip } from "antd";
import { activate, extendTrial, generateCodes, openWorkspace, resetAiAllowance, suspend } from "./actions";
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
 * 运营台。开工作区、开通、延长试用、停用。
 * 不做成完整后台——工作区数量还在两位数的阶段，一张表加几个按钮就够，
 * 多做的每一块都要跟着业务改。
 */
type Code = { code: string; note: string | null; usedAt: string | null; workspace: string | null };

export default function AdminView({ token, rows, codes }: { token: string; rows: Row[]; codes: Code[] }) {
  const { message } = App.useApp();
  const [plan, setPlan] = useState<PlanKey>("year");
  const [busy, setBusy] = useState<string | null>(null);
  const [开号form] = Form.useForm();
  const [开号中, set开号中] = useState(false);
  const [开号弹窗, set开号弹窗] = useState(false);
  /** 开成之后的交付文本。密码只在这里出现这一次，关掉就再也看不到 */
  const [交付文本, set交付文本] = useState<string | null>(null);

  async function 提交开号() {
    const v = await 开号form.validateFields().catch(() => null);
    if (!v) return;
    set开号中(true);
    const r = await openWorkspace({ token, workspace: v.workspace, name: v.name, target: v.target });
    set开号中(false);
    if (!r.ok) {
      message.error(r.error);
      return;
    }
    set交付文本(
      [
        `登录地址：${window.location.origin}/login`,
        `账号：${r.contact}`,
        `初始密码：${r.password}`,
        "",
        "登录后请在「设置」里改掉密码。试用 7 天，到期后数据保留、转为只读。",
      ].join("\n"),
    );
    开号form.resetFields();
  }

  async function run(id: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(id);
    const r = await fn();
    setBusy(null);
    if (r.ok) message.success("已更新");
    else message.error(r.error ?? "操作失败");
  }

  const 待核对 = rows.filter((r) => r.note?.includes("[待核对]")).length;
  const [生成中, set生成中] = useState(false);
  const [新码, set新码] = useState<string[] | null>(null);
  const 未用 = codes.filter((c) => !c.usedAt);

  async function 生成十个() {
    set生成中(true);
    const r = await generateCodes({ token, count: 10 });
    set生成中(false);
    if (r.ok) set新码(r.codes);
    else message.error(r.error);
  }

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 4px" }}>工作区</h1>
      <div style={{ color: "#6b7280", fontSize: 13, marginBottom: 16 }}>
        共 {rows.length} 个，{rows.filter((r) => r.status === "TRIAL" && r.writable).length} 个在试用
        {待核对 > 0 && <span style={{ color: "#b45309" }}>，{待核对} 个待核对付款</span>}
      </div>

      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <Button type="primary" onClick={() => set开号弹窗(true)}>
          开工作区
        </Button>
        <span style={{ flex: 1 }} />
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
            width: 290,
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
                <Button size="small" onClick={() => run(r.id, () => resetAiAllowance({ token, workspaceId: r.id }))}>
                  重置 AI
                </Button>
                <Button size="small" danger={r.status !== "SUSPENDED"} onClick={() => run(r.id, () => suspend({ token, workspaceId: r.id, on: r.status !== "SUSPENDED" }))}>
                  {r.status === "SUSPENDED" ? "恢复" : "停用"}
                </Button>
              </div>
            ),
          },
        ]}
      />

      {/* 激活码：一码一个工作区。发给要试用的人，他自己去 /signup 开号，不用我们建 */}
      <div style={{ margin: "28px 0 12px", display: "flex", alignItems: "center", gap: 8 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>激活码</h2>
        <span style={{ fontSize: 13, color: "#6b7280" }}>未用 {未用.length} · 已用 {codes.length - 未用.length}</span>
        <span style={{ flex: 1 }} />
        <Button size="small" loading={生成中} onClick={生成十个}>生成 10 个</Button>
      </div>
      {新码 && (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 12 }}
          message={`新生成 ${新码.length} 个，一码一用`}
          description={<Input.TextArea value={新码.join("\n")} autoSize readOnly onFocus={(e) => e.currentTarget.select()} style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }} />}
          closable
          onClose={() => set新码(null)}
        />
      )}
      <Table<Code>
        rowKey="code"
        size="small"
        dataSource={codes}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        columns={[
          { title: "激活码", dataIndex: "code", render: (v: string) => <span style={{ fontFamily: "ui-monospace, monospace" }}>{v}</span> },
          { title: "备注", dataIndex: "note", render: (v: string | null) => v ?? <span style={{ color: "#d1d5db" }}>—</span> },
          { title: "状态", dataIndex: "usedAt", width: 160, render: (v: string | null, r) => (v ? <Tag>已用 · {r.workspace ?? ""}</Tag> : <Tag color="processing">未用</Tag>) },
        ]}
      />

      {/* 开工作区：客户从官网发邮件过来，聊完在这里建号，把交付文本复制进邮件回复 */}
      <Modal
        open={开号弹窗}
        title={交付文本 ? "开好了" : "开一个试用工作区"}
        onCancel={() => {
          set开号弹窗(false);
          set交付文本(null);
        }}
        footer={
          交付文本 ? (
            <Button
              type="primary"
              onClick={() => {
                set开号弹窗(false);
                set交付文本(null);
              }}
            >
              我已复制，关闭
            </Button>
          ) : (
            <>
              <Button onClick={() => set开号弹窗(false)}>取消</Button>
              <Button type="primary" loading={开号中} onClick={提交开号}>
                建立
              </Button>
            </>
          )
        }
      >
        {交付文本 ? (
          <>
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="密码只显示这一次"
              description="关掉之后没有任何地方能再看到它。忘了只能重开一个工作区。"
            />
            <Input.TextArea value={交付文本} autoSize readOnly onFocus={(e) => e.currentTarget.select()} style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }} />
            <Button
              size="small"
              style={{ marginTop: 8 }}
              onClick={() => {
                navigator.clipboard.writeText(交付文本).then(
                  () => message.success("已复制，粘进邮件回复即可"),
                  () => message.error("复制失败，手动选中吧"),
                );
              }}
            >
              复制
            </Button>
          </>
        ) : (
          <Form form={开号form} layout="vertical" style={{ marginTop: 8 }}>
            <Form.Item name="workspace" label="团队名称" rules={[{ required: true, message: "填对方的机构名" }]}>
              <Input placeholder="如「启明教育」" maxLength={40} />
            </Form.Item>
            <Form.Item name="name" label="对方姓名" rules={[{ required: true, message: "填联系人姓名" }]}>
              <Input placeholder="如「王老师」" maxLength={20} />
            </Form.Item>
            <Form.Item name="target" label="手机号或邮箱" extra="这就是他的登录账号" rules={[{ required: true, message: "填手机号或邮箱" }]}>
              <Input placeholder="13800138000 或 wang@example.com" />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </div>
  );
}
