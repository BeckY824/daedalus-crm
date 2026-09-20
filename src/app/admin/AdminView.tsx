"use client";

import { useState } from "react";
import { App, Alert, Button, Form, Input, Modal, Popconfirm, Select, Table, Tag, Tooltip } from "antd";
import { activate, extendTrial, grantAi, openWorkspace, suspend, 标记反馈 } from "./actions";
import type { 成本概览 } from "@/lib/tenant/ai-cost";
import { palette } from "@/lib/palette";

const 千分位 = (n: number) => n.toLocaleString("zh-CN");
/** 短的原样给，长的（cuid）只留尾巴——截成半截的名字比不显示更难认 */
const 短id = (id: string) => (id.length <= 12 ? id : `…${id.slice(-8)}`);
/** 「三天前」这种说法比一串时间戳好认——运营台是扫一眼的地方，不是查档的地方 */
/** 送过、而且用光了。没送过的不算——那是「没有过」，不是「用完了」 */
const 用完了 = (a: { ai: { 送: number; 剩: number } }) => a.ai.送 > 0 && a.ai.剩 === 0;

function 何时(iso: string | null): string {
  if (!iso) return "—";
  const 天 = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (天 <= 0) return "今天";
  if (天 === 1) return "昨天";
  if (天 < 30) return `${天} 天前`;
  return iso.slice(0, 10);
}
/** 近 N 天一共多少钱。没配单价时不会被调到 */
const 钱 = (c: 成本概览) => ((c.合计.入 * (c.单价?.入 ?? 0)) + (c.合计.出 * (c.单价?.出 ?? 0))) / 1e6;
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
/** 一个云端账号。**桌面端用户就是这个**，他没有工作区 */
type 账号条 = {
  id: string;
  name: string;
  contact: string;
  createdAt: string;
  lastLoginAt: string | null;
  active: boolean;
  设备: number;
  最近用令牌: string | null;
  ai: { 送: number; 用: number; 剩: number };
  工作区数: number;
};

export default function AdminView({ token, rows, 环境, 反馈, 成本, 账号 }: { token: string; rows: Row[]; 环境: "生产" | "本地"; 反馈: 反馈条[]; 成本: 成本概览; 账号: 账号条[] }) {
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
        账号。**桌面端用户全在这儿，上面那张按工作区列的表里一个都没有**——
        桌面端注册只开一个云端账号（记 AI 次数、发设备令牌），数据在他自己机器上，
        根本不存在工作区。内测用户全是这一类。

        「剩」是最该盯的一列：送的是注册 30 + 每天补 3，用完了他就问不了了，
        而他多半不会来告诉你，只会觉得「这东西不好用」。
      */}
      <div className="ops-cost">
        <h2>
          账号
          <span>
            共 {账号.length} 个 · 其中纯桌面端 {账号.filter((a) => a.工作区数 === 0).length} 个
            {/* 「送过但用完了」才算用完。从来没送过次数的（网页版账号）不是用完，是没有过 */}
            {账号.some(用完了) && ` · ${账号.filter(用完了).length} 个次数已用完`}
          </span>
        </h2>
        {账号.length === 0 ? (
          <p className="ops-fb-empty">还没有人注册。</p>
        ) : (
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={账号}
            columns={[
              {
                title: "账号",
                render: (_: unknown, a: 账号条) => (
                  <>
                    <b>{a.name}</b>
                    {a.contact && <span style={{ color: palette.textMuted, marginLeft: 8 }}>{a.contact}</span>}
                    {!a.active && <Tag color="red" style={{ marginLeft: 8 }}>已停用</Tag>}
                  </>
                ),
              },
              {
                title: "来路",
                width: 110,
                render: (_: unknown, a: 账号条) =>
                  a.工作区数 === 0 ? <Tag color="blue">桌面端</Tag> : <Tag>网页版</Tag>,
              },
              { title: "设备", width: 70, render: (_: unknown, a: 账号条) => `${a.设备} 台` },
              {
                title: "AI 次数",
                width: 170,
                render: (_: unknown, a: 账号条) =>
                  a.ai.送 === 0 && a.ai.用 === 0 ? (
                    // 没送过也没用过：网页版账号走工作区那本账，这一列对它没有意义
                    <span style={{ color: palette.textFaint }}>—</span>
                  ) : (
                    <span style={{ color: 用完了(a) ? palette.dangerText : undefined }}>
                      剩 <b>{a.ai.剩}</b> · 送 {a.ai.送} / 用 {a.ai.用}
                    </span>
                  ),
              },
              {
                title: "最近活跃",
                width: 150,
                render: (_: unknown, a: 账号条) => 何时(a.最近用令牌 ?? a.lastLoginAt),
              },
              { title: "注册", width: 120, render: (_: unknown, a: 账号条) => a.createdAt.slice(0, 10) },
            ]}
          />
        )}
      </div>

      {/*
        模型成本。**「¥29 / 300 次」现在是照公开价估的**，这一块就是为了把它换成算出来的。
        数据只能随时间攒、补不回来，所以它先于任何「看起来更要紧」的东西。

        钱只在配了单价时才显示：我们走中转站，公开价不是实付价，
        先拍一个估值再拿它算，等于把猜测洗成「数据」。没配就只给 token。
      */}
      <div className="ops-cost">
        <h2>
          模型成本
          <span>
            近 {成本.天数} 天 · {成本.合计.次数} 次 · 入 {千分位(成本.合计.入)} / 出 {千分位(成本.合计.出)} token
            {成本.合计.次数 > 0 && ` · 平均一次 ${Math.round((成本.合计.入 + 成本.合计.出) / 成本.合计.次数)} token`}
          </span>
        </h2>

        {成本.合计.次数 === 0 ? (
          <p className="ops-fb-empty">还没有记录。这张表从 0.44.0 起才开始写——在那之前的调用补不回来。</p>
        ) : (
          <>
            <p className="ops-cost-money">
              {成本.单价
                ? `按 入 ¥${成本.单价.入} / 出 ¥${成本.单价.出} 每百万 token 算：近 ${成本.天数} 天 ¥${钱(成本).toFixed(2)}，` +
                  `平均一次 ¥${(钱(成本) / Math.max(1, 成本.合计.次数)).toFixed(4)}`
                : "没配单价，只显示 token。等账单对上了把真实数字填进 LLM_PRICE_IN / LLM_PRICE_OUT，历史能整个重算。"}
            </p>

            <div className="ops-cost-grid">
              <div>
                <h3>按天</h3>
                <table>
                  <tbody>
                    {成本.按天.map((d) => (
                      <tr key={d.日}>
                        <td>{d.日.slice(5)}</td>
                        <td>{d.次数} 次</td>
                        <td>{千分位(d.入 + d.出)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h3>按模型</h3>
                <table>
                  <tbody>
                    {成本.按模型.map((m) => (
                      <tr key={m.model}>
                        <td>{m.model}</td>
                        <td>{m.次数} 次</td>
                        <td>{千分位(m.入 + m.出)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h3>烧得最多的前 10</h3>
                <table>
                  <tbody>
                    {成本.按归属.map((o) => (
                      <tr key={`${o.kind}:${o.id}`}>
                        <td>{o.名 ?? `${o.kind === "account" ? "桌面端" : "工作区"} ${短id(o.id)}`}</td>
                        <td>{o.次数} 次</td>
                        <td>{千分位(o.入 + o.出)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

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
