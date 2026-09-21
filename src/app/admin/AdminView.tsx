"use client";

import { useState } from "react";
import { App, Alert, Button, Dropdown, Form, Input, Modal, Popconfirm, Select, Table, Tooltip } from "antd";
import { MoreOutlined } from "@ant-design/icons";
import { activate, extendTrial, grantAi, openWorkspace, suspend, 标记反馈 } from "./actions";
import type { 成本概览 } from "@/lib/tenant/ai-cost";
import { PLANS, type PlanKey } from "@/lib/tenant/plans";
import { dayjs } from "@/lib/utils";

const 千分位 = (n: number) => n.toLocaleString("zh-CN");
/** 短的原样给，长的（cuid）只留尾巴——截成半截的名字比不显示更难认 */
const 短id = (id: string) => (id.length <= 12 ? id : `…${id.slice(-8)}`);
/** 送过、而且用光了。没送过的不算——那是「没有过」，不是「用完了」 */
const 用完了 = (a: { ai: { 送: number; 剩: number } }) => a.ai.送 > 0 && a.ai.剩 === 0;
/** 「三天前」这种说法比一串时间戳好认——运营台是扫一眼的地方，不是查档的地方 */
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
  /**
   * 「不过期」。共享工作区的 trialEndsAt 在 2100 年，daysLeft 算出来是 26764——
   * 那个数每天变一次、永远没有意义，报出来看着像 bug。由服务端判定（lib/tenant/workspaces.ts
   * 的 长期有效），不在这儿再算一遍：这个文件是 "use client"，那个模块带着 node:fs 和 prisma。
   */
  长期: boolean;
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

/**
 * 一格数：大字是数，下面一行是**口径**。
 * 没有口径的数没人敢拿它做决定——「3」到底是三个工作区还是三个付费的，差着一门生意。
 */
function 数字卡({ 名, 数, 尾, 注, 警 }: { 名: string; 数: number | string; 尾?: string; 注: string; 警?: boolean }) {
  return (
    <div className={`ops-stat${警 ? " ops-stat-warn" : ""}`}>
      <span className="ops-stat-k">{名}</span>
      <b>
        {typeof 数 === "number" ? 千分位(数) : 数}
        {尾 && <i>{尾}</i>}
      </b>
      <span className="ops-stat-n">{注}</span>
    </div>
  );
}

/**
 * AI 次数那一列：一条细条 + 「剩 N / 送 M」。
 * 看的人问的是「快用完没」，而两个数做减法要在脑子里跑一遍；
 * 一条走到头的红条不用读就知道出事了。
 */
function 次数条({ 剩, 送 }: { 剩: number; 送: number }) {
  if (送 === 0 && 剩 === 0) return <span style={{ color: "var(--text-faint)" }}>—</span>;
  const 比 = 送 > 0 ? Math.max(0, Math.min(1, 剩 / 送)) : 0;
  const 档 = 剩 === 0 ? " ops-meter-out" : 比 <= 0.2 ? " ops-meter-low" : "";
  return (
    <span className={`ops-meter${档}`}>
      <span className="ops-meter-bar" aria-hidden="true">
        <i style={{ width: `${比 * 100}%` }} />
      </span>
      <span className="ops-meter-t">
        {剩} <s>/ {送}</s>
      </span>
    </span>
  );
}

/**
 * 运营台。开工作区、开通、延长试用、停用、看用量、读反馈。
 * 不做成完整后台——工作区数量还在两位数的阶段，一张表加几个动作就够，
 * 多做的每一块都要跟着业务改。
 *
 * 2026-09-21 重做了样子：原来五个区块各长一套（字号、间距、彩色胶囊全凭手写），
 * 每行四个按钮把「还剩多少次」「烧了多少 token」这些真要看的数挤成了配角。
 * 现在一套骨架：KPI 行 → 工作区 → 账号 → 模型成本 → 反馈，24px 节奏；
 * 数字一律等宽右对齐，状态用点，次要动作收进「⋯」。
 */
export default function AdminView({
  token,
  rows,
  环境,
  反馈,
  成本,
  账号,
  渲染于,
}: {
  token: string;
  rows: Row[];
  环境: "生产" | "本地";
  反馈: 反馈条[];
  成本: 成本概览;
  账号: 账号条[];
  渲染于?: string;
}) {
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
  const 成员数 = rows.reduce((s, r) => s + r.members, 0);
  const 设备数 = 账号.reduce((s, a) => s + a.设备, 0);
  const 纯桌面 = 账号.filter((a) => a.工作区数 === 0).length;
  const 用完的 = 账号.filter(用完了).length + rows.filter((r) => !r.paidUntil && 用完了(r)).length;
  const 没处理 = 反馈.filter((f) => !f.handled).length;
  const 平均token = 成本.合计.次数 > 0 ? Math.round((成本.合计.入 + 成本.合计.出) / 成本.合计.次数) : 0;
  /** 按天那排柱子的高度基准。最高那天占满，其余按比例——只看形状，不看绝对值 */
  const 峰值 = Math.max(1, ...成本.按天.map((d) => d.次数));

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
        {/* 这一页是快照，不会自己刷新。不写清截至时间，看的人会拿半小时前的数做决定 */}
        {渲染于 && <span className="ops-top-at">数据截至 {dayjs(渲染于).format("MM-DD HH:mm")}</span>}
        <Button type="primary" size="small" onClick={() => set开号弹窗(true)}>
          开工作区
        </Button>
      </header>

      <div className="ops-body">
        {/* 六个数。前三个是「有多少」，后三个是「要不要动手」——后者为 0 时才算太平 */}
        <div className="ops-stats">
          <数字卡 名="工作区" 数={rows.length} 注={`${试用中} 个在试用 · ${成员数} 名成员`} />
          <数字卡 名="账号" 数={账号.length} 注={`${纯桌面} 个只用桌面端`} />
          <数字卡 名="桌面端设备" 数={设备数} 尾="台" 注="领过设备令牌的" />
          <数字卡
            名={`近 ${成本.天数} 天调用`}
            数={成本.合计.次数}
            尾="次"
            注={成本.合计.次数 > 0 ? `平均一次 ${千分位(平均token)} token` : "还没有记录"}
          />
          <数字卡 名="次数用完" 数={用完的} 注={用完的 > 0 ? "他问不了了，也不会来说" : "没有人卡在额度上"} 警={用完的 > 0} />
          <数字卡 名="待核对付款" 数={待核对} 注={待核对 > 0 ? "备注里有 [待核对]" : "没有要处理的"} 警={待核对 > 0} />
        </div>

        <section className="ops-sec">
          <div className="ops-sec-h">
            <h2>工作区</h2>
            <span>
              共 {rows.length} 个 · {试用中} 个在试用
            </span>
            <span className="ops-sec-r">
              <span style={{ fontSize: "var(--fs-min)", color: "var(--text-muted)" }}>开通用的套餐</span>
              <Select
                size="small"
                value={plan}
                style={{ width: 150 }}
                onChange={setPlan}
                options={(Object.keys(PLANS) as PlanKey[]).map((k) => ({ value: k, label: `${PLANS[k].label} ¥${PLANS[k].price}` }))}
              />
            </span>
          </div>

          <div className="ops-card">
            <Table<Row>
              rowKey="id"
              size="small"
              dataSource={rows}
              pagination={{ pageSize: 30, hideOnSinglePage: true }}
              scroll={{ x: 1000 }}
              columns={[
                {
                  title: "工作区",
                  dataIndex: "name",
                  render: (_, r) => (
                    <div>
                      <div className="ops-name">
                        {r.name}
                        {r.长期 && !r.paidUntil && <span className="ops-badge">共享区</span>}
                      </div>
                      <div className="ops-mono">{r.slug}</div>
                    </div>
                  ),
                },
                {
                  title: "创建者",
                  dataIndex: "owner",
                  render: (_, r) =>
                    r.owner ? (
                      <div>
                        <div>{r.owner.name}</div>
                        <div className="ops-mono">{r.owner.contact}</div>
                      </div>
                    ) : (
                      <span style={{ color: "var(--text-faint)" }}>—</span>
                    ),
                },
                { title: "成员", dataIndex: "members", width: 64, className: "num" },
                {
                  title: "状态",
                  dataIndex: "status",
                  width: 150,
                  render: (_, r) => {
                    if (r.status === "SUSPENDED") return <span className="ops-st ops-st-dead">已停用</span>;
                    if (!r.writable) return <span className="ops-st ops-st-dead">已过期</span>;
                    if (r.paidUntil)
                      return (
                        <span className="ops-st ops-st-paid">
                          已付费 <span className="ops-st-sub">{r.长期 ? "长期" : `${r.daysLeft} 天`}</span>
                        </span>
                      );
                    // 共享区永远可写（trialEndsAt 在 2100 年），报天数只会让人以为是个 bug
                    if (r.长期) return <span className="ops-st ops-st-trial">试用 · 不过期</span>;
                    return (
                      <span className={`ops-st ${r.daysLeft <= 2 ? "ops-st-warn" : "ops-st-trial"}`}>
                        试用 <span className="ops-st-sub">{r.daysLeft} 天</span>
                      </span>
                    );
                  },
                },
                {
                  title: "AI 次数",
                  dataIndex: "ai",
                  width: 130,
                  className: "num",
                  render: (_, r) =>
                    r.paidUntil ? <span style={{ color: "var(--text-muted)" }}>不限</span> : <次数条 剩={r.ai.剩} 送={r.ai.送} />,
                },
                {
                  title: "注册于",
                  dataIndex: "createdAt",
                  width: 104,
                  className: "num",
                  render: (v: string) => <span className="ops-sub">{dayjs(v).format("MM-DD HH:mm")}</span>,
                },
                {
                  title: "备注",
                  dataIndex: "note",
                  render: (v: string | null) =>
                    v ? (
                      <Tooltip title={<span style={{ whiteSpace: "pre-wrap" }}>{v}</span>}>
                        {/* 只显示最后一行、一行装不下就截断：备注是聊出来的流水，全文进 tooltip */}
                        <span
                          style={{
                            display: "block",
                            maxWidth: 180,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            fontSize: "var(--fs-min)",
                            color: v.includes("[待核对]") ? "var(--warning-text)" : "var(--text-muted)",
                          }}
                        >
                          {v.includes("[待核对]") && "● "}
                          {v.split("\n").slice(-1)[0]}
                        </span>
                      </Tooltip>
                    ) : (
                      <span style={{ color: "var(--text-faint)" }}>—</span>
                    ),
                },
                {
                  title: "",
                  width: 96,
                  fixed: "right",
                  render: (_, r) => (
                    /*
                      主动作留在外面，其余三个收进「⋯」。
                      原来四个按钮一行、五行就是二十个——那面按钮墙比任何一列数都显眼，
                      而「开通」之外的三个一周也用不上一次。
                    */
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <Popconfirm
                        title={`按${PLANS[plan].label} ¥${PLANS[plan].price} 开通？`}
                        onConfirm={() => run(r.id, () => activate({ token, workspaceId: r.id, plan }))}
                      >
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
                            r.status === "SUSPENDED"
                              ? { key: "on", label: "恢复使用" }
                              : { key: "off", label: "停用这个工作区", danger: true },
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
          </div>
        </section>

        {/*
          账号。**桌面端用户全在这儿，上面那张按工作区列的表里一个都没有**——
          桌面端注册只开一个云端账号（记 AI 次数、发设备令牌），数据在他自己机器上，
          根本不存在工作区。内测用户全是这一类。

          「剩」是最该盯的一列：送的是注册 30 + 每天补 3，用完了他就问不了了，
          而他多半不会来告诉你，只会觉得「这东西不好用」。
        */}
        <section className="ops-sec">
          <div className="ops-sec-h">
            <h2>账号</h2>
            <span>
              共 {账号.length} 个 · 其中 {纯桌面} 个只用桌面端
              {账号.some(用完了) && ` · ${账号.filter(用完了).length} 个次数已用完`}
            </span>
          </div>
          {账号.length === 0 ? (
            <p className="ops-empty">还没有人注册。</p>
          ) : (
            <div className="ops-card">
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={账号}
                columns={[
                  {
                    title: "账号",
                    render: (_: unknown, a: 账号条) => (
                      <div>
                        <div className="ops-name">
                          {a.name}
                          {!a.active && <span className="ops-badge">已停用</span>}
                        </div>
                        {a.contact && <div className="ops-mono">{a.contact}</div>}
                      </div>
                    ),
                  },
                  {
                    title: "来路",
                    width: 92,
                    render: (_: unknown, a: 账号条) => (
                      <span className="ops-sub">{a.工作区数 === 0 ? "桌面端" : "网页版"}</span>
                    ),
                  },
                  {
                    title: "设备",
                    width: 72,
                    className: "num",
                    render: (_: unknown, a: 账号条) =>
                      a.设备 === 0 ? <span style={{ color: "var(--text-faint)" }}>—</span> : `${a.设备} 台`,
                  },
                  {
                    title: "AI 次数",
                    width: 130,
                    className: "num",
                    // 网页版账号走工作区那本账，这一列对它没有意义（次数条 会显示「—」）
                    render: (_: unknown, a: 账号条) => <次数条 剩={a.ai.剩} 送={a.ai.送} />,
                  },
                  {
                    title: "用掉",
                    width: 72,
                    className: "num",
                    render: (_: unknown, a: 账号条) =>
                      a.ai.用 === 0 ? <span style={{ color: "var(--text-faint)" }}>0</span> : 千分位(a.ai.用),
                  },
                  {
                    title: "最近活跃",
                    width: 104,
                    render: (_: unknown, a: 账号条) => <span className="ops-sub">{何时(a.最近用令牌 ?? a.lastLoginAt)}</span>,
                  },
                  {
                    title: "注册",
                    width: 104,
                    className: "num",
                    render: (_: unknown, a: 账号条) => <span className="ops-sub">{a.createdAt.slice(0, 10)}</span>,
                  },
                ]}
              />
            </div>
          )}
        </section>

        {/*
          模型成本。**「¥29 / 300 次」现在是照公开价估的**，这一块就是为了把它换成算出来的。
          数据只能随时间攒、补不回来，所以它先于任何「看起来更要紧」的东西。

          钱只在配了单价时才显示：我们走中转站，公开价不是实付价，
          先拍一个估值再拿它算，等于把猜测洗成「数据」。没配就只给 token。
        */}
        <section className="ops-sec">
          <div className="ops-sec-h">
            <h2>模型成本</h2>
            <span>
              近 {成本.天数} 天 · {成本.合计.次数} 次 · 入 {千分位(成本.合计.入)} / 出 {千分位(成本.合计.出)} token
              {成本.合计.次数 > 0 && ` · 平均一次 ${千分位(平均token)} token`}
            </span>
          </div>

          {成本.合计.次数 === 0 ? (
            <p className="ops-empty">还没有记录。这张表从 0.44.0 起才开始写——在那之前的调用补不回来。</p>
          ) : (
            <>
              <div className="ops-cost-top">
                {/* 按天先画成柱子：趋势是这一块唯一真正要看的东西，用数字表达要读十四行 */}
                <div className="ops-box">
                  <h3>
                    按天 <em>近 {成本.天数} 天的调用次数</em>
                  </h3>
                  <div className="ops-spark">
                    {成本.按天.map((d) => (
                      <Tooltip key={d.日} title={`${d.日} · ${d.次数} 次 · ${千分位(d.入 + d.出)} token`}>
                        <span
                          className={`ops-spark-b${d.次数 === 峰值 ? " on" : ""}`}
                          style={{ height: `${Math.max(3, (d.次数 / 峰值) * 100)}%` }}
                        />
                      </Tooltip>
                    ))}
                  </div>
                  <div className="ops-spark-x">
                    <span>{成本.按天[0]?.日.slice(5)}</span>
                    <span>峰值 {峰值} 次</span>
                    <span>{成本.按天[成本.按天.length - 1]?.日.slice(5)}</span>
                  </div>
                </div>

                <div className="ops-box">
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

                <div className="ops-box">
                  <h3>
                    烧得最多 <em>前 10</em>
                  </h3>
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

              <p className="ops-cost-money">
                {成本.单价
                  ? `按 入 ¥${成本.单价.入} / 出 ¥${成本.单价.出} 每百万 token 算：近 ${成本.天数} 天 ¥${钱(成本).toFixed(2)}，` +
                    `平均一次 ¥${(钱(成本) / Math.max(1, 成本.合计.次数)).toFixed(4)}`
                  : "没配单价，只显示 token。等账单对上了把真实数字填进 LLM_PRICE_IN / LLM_PRICE_OUT，历史能整个重算。"}
              </p>
            </>
          )}
        </section>

        {/*
          用户反馈。**和工作区摆在同一页**：没人看的收件箱等于没有这个功能，
          而我们每天都会开这一页。未处理的排在上面、左侧有一道竖条；读过的收成灰的。
        */}
        <section className="ops-sec">
          <div className="ops-sec-h">
            <h2>反馈</h2>
            <span>
              {没处理} 条没处理 · 共 {反馈.length}
            </span>
          </div>
          {反馈.length === 0 ? (
            <p className="ops-empty">还没有人发过反馈。</p>
          ) : (
            [...反馈]
              .sort((a, b) => Number(a.handled) - Number(b.handled))
              .map((f) => (
                <div key={f.id} className={`ops-fb-item ${f.handled ? "done" : "todo"}`}>
                  <div className="ops-fb-h">
                    <b>{f.who || "（不知道是谁）"}</b>
                    <span>{f.source === "desktop" ? "桌面端" : "网页"}</span>
                    <span>{dayjs(f.at).format("MM-DD HH:mm")}</span>
                    {f.version && <span>v{f.version}</span>}
                    {f.path && <span className="ops-mono">{f.path}</span>}
                    <span style={{ flex: 1 }} />
                    {/* 系统信息挺长，放进 tooltip：它只在「复现不出来」的时候才要看 */}
                    {f.platform && (
                      <Tooltip title={f.platform}>
                        <span className="ops-fb-ua">系统</span>
                      </Tooltip>
                    )}
                    <Button
                      size="small"
                      type={f.handled ? "text" : "default"}
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
        </section>
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
            {/* 整段要发给客户，所以是一块可整体选中的等宽文本，不是一行输入框 */}
            <pre className="ops-hand" onClick={(e) => getSelection()?.selectAllChildren(e.currentTarget)}>
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
    </div>
  );
}
