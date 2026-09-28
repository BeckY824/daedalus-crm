"use client";

import { useState } from "react";
import { Alert, App, Button, Dropdown, Form, Input, Modal, Popconfirm, Select, Table, Tooltip } from "antd";
import { AppstoreOutlined, ClockCircleOutlined, ExclamationCircleOutlined, MoreOutlined, PlusOutlined, TeamOutlined, WalletOutlined } from "@ant-design/icons";
import { activate, extendTrial, grantAi, openWorkspace, suspend } from "../actions";
import { PLANS, type PlanKey } from "@/lib/tenant/plans";
import { dayjs } from "@/lib/utils";
import { 页头 } from "../OpsShell";
import { Kpi, 卡片, 次数条 } from "../ui";
import type { 工作区行 } from "../data";

const 用完了 = (a: { ai: { 送: number; 剩: number } }) => a.ai.送 > 0 && a.ai.剩 === 0;

/**
 * 工作区（网页版）。改版前它是运营台首页的第一张表，动作一个没少，只是搬了家：
 * 开工作区（右上）、开通（每行的主按钮）、试用 +7 天 / AI +10 / 停用（收进「⋯」）。
 */
export default function WorkspacesView({ token, rows }: { token: string; rows: 工作区行[] }) {
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
  const 试用中 = rows.filter((r) => r.status === "TRIAL" && r.writable).length;
  const 付费 = rows.filter((r) => r.paidUntil && new Date(r.paidUntil) > new Date()).length;
  const 成员数 = rows.reduce((s, r) => s + r.members, 0);
  const 卡住 = rows.filter((r) => !r.paidUntil && 用完了(r)).length;

  return (
    <>
      <页头
        标题="工作区"
        说明="网页版：一个团队一个工作区。开号、开通、延长试用、停用都在这里"
        右={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => set开号弹窗(true)}>
            开工作区
          </Button>
        }
      />

      <div className="opx-kpis">
        <Kpi 名="工作区" icon={<AppstoreOutlined />} 数={rows.length} 注={`${试用中} 个在试用 · ${付费} 个已付费`} />
        <Kpi 名="成员" icon={<TeamOutlined />} 数={成员数} 尾="人" 注="所有工作区加起来" />
        <Kpi 名="AI 次数用完" icon={<ExclamationCircleOutlined />} 数={卡住} 注={卡住 ? "试用里的团队问不了 AI 了" : "没有工作区卡在额度上"} 警={卡住 > 0} 静={卡住 === 0} />
        <Kpi 名="待核对付款" icon={<WalletOutlined />} 数={待核对} 注={待核对 ? "备注里有 [待核对]" : "没有要处理的"} 警={待核对 > 0} 静={待核对 === 0} />
      </div>

      <卡片
        平
        标题="全部工作区"
        说明={`共 ${rows.length} 个`}
        右={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, paddingRight: 20 }}>
            <span className="opx-muted" style={{ fontSize: 12.5 }}>
              开通用的套餐
            </span>
            <Select
              size="small"
              value={plan}
              style={{ width: 150 }}
              onChange={setPlan}
              options={(Object.keys(PLANS) as PlanKey[]).map((k) => ({ value: k, label: `${PLANS[k].label} ¥${PLANS[k].price}` }))}
            />
          </span>
        }
      >
        <div style={{ height: 14 }} />
        <Table<工作区行>
          rowKey="id"
          size="middle"
          dataSource={rows}
          pagination={{ pageSize: 30, hideOnSinglePage: true }}
          scroll={{ x: 1040 }}
          locale={{ emptyText: <div className="opx-empty">还没有工作区</div> }}
          columns={[
            {
              title: "工作区",
              dataIndex: "name",
              render: (_, r) => (
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {r.name}
                    {r.长期 && !r.paidUntil && (
                      <span className="opx-tag opx-tag-blue" style={{ marginLeft: 8 }}>
                        共享区
                      </span>
                    )}
                  </div>
                  <div className="opx-mono">{r.slug}</div>
                </div>
              ),
            },
            {
              title: "创建者",
              render: (_, r) =>
                r.owner ? (
                  <div>
                    <div>{r.owner.name}</div>
                    <div className="opx-mono">{r.owner.contact}</div>
                  </div>
                ) : (
                  <span className="opx-faint">—</span>
                ),
            },
            { title: "成员", dataIndex: "members", width: 70, className: "num" },
            {
              title: "状态",
              width: 150,
              render: (_, r) => {
                if (r.status === "SUSPENDED") return <span className="opx-tag opx-tag-dead">已停用</span>;
                if (!r.writable) return <span className="opx-tag opx-tag-dead">已过期</span>;
                if (r.paidUntil) return <span className="opx-tag opx-tag-ok">已付费 · {r.长期 ? "长期" : `${r.daysLeft} 天`}</span>;
                // 共享区永远可写（trialEndsAt 在 2100 年），报天数只会让人以为是个 bug
                if (r.长期) return <span className="opx-tag opx-tag-blue">试用 · 不过期</span>;
                return (
                  <span className={`opx-tag ${r.daysLeft <= 2 ? "opx-tag-warn" : "opx-tag-blue"}`}>
                    <ClockCircleOutlined style={{ marginRight: 4 }} />
                    试用 · {r.daysLeft} 天
                  </span>
                );
              },
            },
            {
              title: "AI 次数",
              width: 150,
              render: (_, r) => (r.paidUntil ? <span className="opx-muted">不限</span> : <次数条 剩={r.ai.剩} 送={r.ai.送} />),
            },
            {
              title: "注册于",
              width: 110,
              className: "num",
              render: (_, r) => <span className="opx-muted">{dayjs(r.createdAt).format("MM-DD HH:mm")}</span>,
            },
            {
              title: "备注",
              render: (_, r) =>
                r.note ? (
                  <Tooltip title={<span style={{ whiteSpace: "pre-wrap" }}>{r.note}</span>}>
                    {/* 只显示最后一行、一行装不下就截断：备注是聊出来的流水，全文进悬停 */}
                    <span
                      style={{
                        display: "block",
                        maxWidth: 180,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 12.5,
                        color: r.note.includes("[待核对]") ? "var(--x-warn)" : "var(--x-muted)",
                      }}
                    >
                      {r.note.includes("[待核对]") && "● "}
                      {r.note.split("\n").slice(-1)[0]}
                    </span>
                  </Tooltip>
                ) : (
                  <span className="opx-faint">—</span>
                ),
            },
            {
              title: "",
              width: 104,
              fixed: "right",
              render: (_, r) => (
                /* 主动作留在外面，其余三个收进「⋯」：一周也用不上一次的按钮不该堆成一面墙 */
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  <Popconfirm title={`按${PLANS[plan].label} ¥${PLANS[plan].price} 开通？`} onConfirm={() => run(r.id, () => activate({ token, workspaceId: r.id, plan }))}>
                    <Button size="small" type="primary" loading={busy === r.id}>
                      开通
                    </Button>
                  </Popconfirm>
                  <Dropdown
                    trigger={["click"]}
                    menu={{
                      items: [
                        { key: "ext", label: "试用 +7 天" },
                        { key: "ai", label: "AI 次数 +10" },
                        { type: "divider" as const },
                        r.status === "SUSPENDED" ? { key: "on", label: "恢复使用" } : { key: "off", label: "停用这个工作区", danger: true },
                      ],
                      onClick: ({ key }) => {
                        if (key === "ext") run(r.id, () => extendTrial({ token, workspaceId: r.id, days: 7 }));
                        if (key === "ai") run(r.id, () => grantAi({ token, workspaceId: r.id, amount: 10 }));
                        if (key === "off") run(r.id, () => suspend({ token, workspaceId: r.id, on: true }));
                        if (key === "on") run(r.id, () => suspend({ token, workspaceId: r.id, on: false }));
                      },
                    }}
                  >
                    <Button size="small" type="text" icon={<MoreOutlined />} aria-label="更多操作" />
                  </Dropdown>
                </div>
              ),
            },
          ]}
        />
      </卡片>

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
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="密码只显示这一次" description="关掉之后没有任何地方能再看到它。忘了只能重开一个工作区。" />
            {/* 整段要发给客户，所以是一块可整体选中的等宽文本，不是一行输入框 */}
            <pre className="opx-hand" onClick={(e) => getSelection()?.selectAllChildren(e.currentTarget)}>
              {交付文本}
            </pre>
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
    </>
  );
}
