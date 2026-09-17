"use client";

import { useState } from "react";
import { App, Alert, Button, Form, Input, Modal, Popconfirm, Select, Table, Tag, Tooltip } from "antd";
import { activate, extendTrial, grantAi, openWorkspace, suspend, 标记反馈 } from "./actions";
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
  /** AI 免费次数：送了多少、还剩多少 */
  ai: { 送: number; 剩: number };
  note: string | null;
};

/** 用户发来的一条反馈。正文是他自己写的，其余几样是界面替他附上的 */
type 反馈条 = {
  id: string;
  at: string;
  source: string;
  body: string;
  path: string | null;
  version: string | null;
  platform: string | null;
  who: string | null;
  handled: boolean;
};

/**
 * 运营台。开工作区、开通、延长试用、停用。
 * 不做成完整后台——工作区数量还在两位数的阶段，一张表加几个按钮就够，
 * 多做的每一块都要跟着业务改。
 */
export default function AdminView({ token, rows, 环境, 反馈 }: { token: string; rows: Row[]; 环境: "生产" | "本地"; 反馈: 反馈条[] }) {
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
  const 成员数 = rows.reduce((s2, r) => s2 + r.members, 0);

  return (
    <div className="ops">
      {/*
        深色顶栏（设计稿 21/LOW-FREQUENCY）。它不只是好看：这一页对着的是**线上库**，
        一个动作就能停掉别人的工作区。顶栏和环境标记是为了让人一眼知道自己在哪儿——
        运营台和产品长得一样的时候，人会以为自己还在自己的工作区里点。
      */}
      <header className="ops-top">
        <b>Daedalus Ops</b>
        <span className={`ops-env${环境 === "生产" ? " ops-env-live" : ""}`}>{环境 === "生产" ? "PRODUCTION" : "本地"}</span>
        <span style={{ flex: 1 }} />
        <Button type="primary" size="small" onClick={() => set开号弹窗(true)}>
          开工作区
        </Button>
      </header>

      <div className="ops-body">
        {/* 三个数，每个都说清口径。待核对有人时整张卡变黄——它是唯一要人动手的那一项 */}
        <div className="ops-stats">
          <div className="ops-stat">
            <span className="ops-stat-k">工作区</span>
            <b>{rows.length}</b>
            <span className="ops-stat-n">{试用中} 个在试用</span>
          </div>
          <div className="ops-stat">
            <span className="ops-stat-k">成员合计</span>
            <b>{成员数}</b>
            <span className="ops-stat-n">全部工作区</span>
          </div>
          <div className={`ops-stat${待核对 > 0 ? " ops-stat-warn" : ""}`}>
            <span className="ops-stat-k">待核对付款</span>
            <b>{待核对}</b>
            <span className="ops-stat-n">{待核对 > 0 ? "备注里有 [待核对]" : "没有要处理的"}</span>
          </div>
        </div>

      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>开通用的套餐</span>
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
                <div style={{ fontSize: "var(--fs-min)", color: "var(--text-muted)" }}>{r.slug}</div>
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
            title: "AI 次数",
            dataIndex: "ai",
            width: 90,
            render: (_, r) => (r.paidUntil ? <span style={{ color: "var(--text-muted)" }}>不限</span> : <span style={{ color: r.ai.剩 === 0 ? "var(--warning-text)" : undefined }}>{r.ai.剩} / {r.ai.送}</span>),
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
                  <span style={{ color: v.includes("[待核对]") ? "var(--warning-text)" : "var(--text-muted)", fontSize: "var(--fs-min)" }}>
                    {v.split("\n").slice(-1)[0].slice(0, 30)}
                  </span>
                </Tooltip>
              ) : (
                <span style={{ color: "var(--text-faint)" }}>—</span>
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
                <Button size="small" onClick={() => run(r.id, () => grantAi({ token, workspaceId: r.id, amount: 10 }))}>
                  AI +10
                </Button>
                <Button size="small" danger={r.status !== "SUSPENDED"} onClick={() => run(r.id, () => suspend({ token, workspaceId: r.id, on: r.status !== "SUSPENDED" }))}>
                  {r.status === "SUSPENDED" ? "恢复" : "停用"}
                </Button>
              </div>
            ),
          },
        ]}
      />

      {/*
        用户反馈。**和工作区摆在同一页**：没人看的收件箱等于没有这个功能，
        而我们每天都会开这一页。未处理的排在上面，读过的按一下收成灰的。
      */}
      <div className="ops-fb">
        <h2>
          反馈
          <span>{反馈.filter((f) => !f.handled).length} 条没处理 · 共 {反馈.length}</span>
        </h2>
        {反馈.length === 0 ? (
          <p className="ops-fb-empty">还没有人发过反馈。</p>
        ) : (
          [...反馈]
            .sort((a, b) => Number(a.handled) - Number(b.handled))
            .map((f) => (
              <div key={f.id} className={`ops-fb-item${f.handled ? " done" : ""}`}>
                <div className="ops-fb-h">
                  <b>{f.who || "（不知道是谁）"}</b>
                  <Tag color={f.source === "desktop" ? "blue" : "default"}>{f.source === "desktop" ? "桌面端" : "网页"}</Tag>
                  <span>{dayjs(f.at).format("MM-DD HH:mm")}</span>
                  {f.version && <span>v{f.version}</span>}
                  {f.path && <span>{f.path}</span>}
                  <span style={{ flex: 1 }} />
                  {/* 系统信息挺长，放进 tooltip：它只在「复现不出来」的时候才要看 */}
                  {f.platform && (
                    <Tooltip title={f.platform}>
                      <span className="ops-fb-ua">系统</span>
                    </Tooltip>
                  )}
                  <Button
                    size="small"
                    type={f.handled ? "default" : "primary"}
                    onClick={() => run(f.id, () => 标记反馈({ token, id: f.id, handled: !f.handled }))}
                  >
                    {f.handled ? "重新打开" : "处理过了"}
                  </Button>
                </div>
                {/* 原话原样显示，换行照他敲的来——改写别人的话是复现问题时最容易丢线索的一步 */}
                <p>{f.body}</p>
              </div>
            ))
        )}
      </div>

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
            <Input.TextArea value={交付文本} autoSize readOnly onFocus={(e) => e.currentTarget.select()} style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }} />
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
    </div>
  );
}
