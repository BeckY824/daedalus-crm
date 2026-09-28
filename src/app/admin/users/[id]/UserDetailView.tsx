"use client";

import { useState } from "react";
import Link from "next/link";
import { App, Button, Popconfirm, Table } from "antd";
import { DesktopOutlined, FireOutlined, GiftOutlined, ThunderboltOutlined } from "@ant-design/icons";
import Chart from "@/components/Chart";
import { dayjs } from "@/lib/utils";
import { 分布说法 } from "@/lib/device-os";
import { grantAccountAi } from "../../actions";
import { 站内, LinkPending } from "../../OpsShell";
import { Kpi, 卡片, 按天柱图, 横条图, 头像, 何时, 千分位, 次数条, 系统 } from "../../ui";
import type { 用户详情, 设备行 } from "../../data";

/**
 * 一个人的详情。回答四个问题，从上往下：
 *   他是谁、最近还来不来（头）
 *   AI 还剩多少、这个月用了多少、用在哪（数 + 图）
 *   他在几台什么电脑上、停在哪一版（设备表）
 *   次数是怎么来的、他跟我们说过什么（赠送流水、反馈）
 * 唯一的动作是「AI 次数 +10」：内测阶段最常见的求助就是「用完了」。
 */
export default function UserDetailView({ token, 详情 }: { token: string; 详情: 用户详情 }) {
  const { message } = App.useApp();
  const [忙, set忙] = useState(false);
  const a = 详情.账号;
  const 在用 = a.设备.filter((d) => !d.revoked);

  async function 加十次() {
    set忙(true);
    const r = await grantAccountAi({ token, accountId: a.id, amount: 10 });
    set忙(false);
    if (r.ok) message.success(`给 ${a.name} 加了 10 次`);
    else message.error(r.error);
  }

  return (
    <>
      <div className="opx-crumb">
        <Link href={站内(token, "/users")}><LinkPending />用户</Link> / {a.name}
      </div>

      <section className="opx-card" style={{ marginBottom: 14 }}>
        <div className="opx-profile">
          <头像 名={a.name} 大 />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h1>{a.name}</h1>
              <span className={`opx-tag${a.来路 === "桌面端" ? " opx-tag-blue" : ""}`}>{a.来路}</span>
              {a.active ? <span className="opx-tag opx-tag-ok">正常</span> : <span className="opx-tag opx-tag-dead">已停用</span>}
            </div>
            <div className="opx-profile-meta">
              <span>
                联系方式 <b>{a.contact || "—"}</b>
              </span>
              <span>
                注册于 <b className="opx-num">{dayjs(a.createdAt).format("YYYY-MM-DD HH:mm")}</b>
              </span>
              <span>
                最近活跃 <b>{何时(a.最近活跃)}</b>
              </span>
              <span>
                领过注册赠送的电脑 <b className="opx-num">{详情.机器数}</b> 台
              </span>
            </div>
          </div>
          <div style={{ marginLeft: "auto" }}>
            <Popconfirm title={`给 ${a.name} 加 10 次 AI？`} description="记成「运营台加的」，只加不减，加了撤不回。" onConfirm={加十次}>
              <Button type="primary" icon={<GiftOutlined />} loading={忙}>
                AI 次数 +10
              </Button>
            </Popconfirm>
          </div>
        </div>
      </section>

      <div className="opx-kpis">
        <div className="opx-kpi">
          <div className="opx-kpi-k">
            <GiftOutlined /> AI 余额
          </div>
          <div className="opx-kpi-v">
            {a.ai.剩}
            <i>次</i>
          </div>
          <div className="opx-kpi-n" style={{ marginTop: 8 }}>
            <次数条 剩={a.ai.剩} 送={a.ai.送} />
          </div>
        </div>
        <Kpi 名="近 30 天模型调用" icon={<ThunderboltOutlined />} 数={详情.调用30天} 尾="次" 注={`按问题扣的：开户以来 ${千分位(a.ai.用)} 次（一问可能调好几次）`} />
        <Kpi 名="近 30 天 token" icon={<FireOutlined />} 数={详情.token30天} 注={详情.调用30天 ? `平均一次 ${千分位(Math.round(详情.token30天 / 详情.调用30天))}` : "这 30 天没用过"} />
        <Kpi 名="在用设备" icon={<DesktopOutlined />} 数={在用.length} 尾="台" 注={在用.length ? 分布说法(a.分布) : "没有在用的设备"} />
      </div>

      <div className="opx-grid opx-grid-21">
        <卡片 标题="模型调用" 说明="近 30 天，每天多少次；AI 答一个问题会调好几次模型">
          <Chart option={按天柱图(详情.调用趋势)} height={220} />
        </卡片>
        <卡片 标题="用在哪" 说明="近 30 天">
          {详情.功能分布.length ? (
            <>
              <Chart option={横条图(详情.功能分布.map((f) => ({ 名: f.功能, 数: f.次数 })))} height={Math.max(90, 详情.功能分布.length * 30 + 10)} />
              <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--x-muted)" }}>
                模型：
                {详情.模型分布.map((m) => `${m.模型} ${千分位(m.次数)} 次`).join(" · ")}
              </div>
            </>
          ) : (
            <div className="opx-empty">这 30 天没用过 AI</div>
          )}
        </卡片>
      </div>

      <卡片 标题="设备" 说明="一枚设备令牌一行；吊销过的排在后面、灰着" 平 style={{ marginTop: 14 }}>
        <Table<设备行>
          rowKey="id"
          size="middle"
          dataSource={a.设备}
          pagination={false}
          scroll={{ x: 760 }}
          locale={{ emptyText: <div className="opx-empty">没登录过桌面端</div> }}
          rowClassName={(d) => (d.revoked ? "opx-faint" : "")}
          columns={[
            { title: "电脑名", dataIndex: "name", render: (v: string) => <span style={{ fontWeight: 500 }}>{v}</span> },
            { title: "系统", width: 110, render: (_, d) => <系统 名={d.系统} /> },
            { title: "芯片", width: 90, render: (_, d) => <span className="opx-muted">{d.arch ?? "—"}</span> },
            { title: "版本", width: 90, render: (_, d) => (d.version ? <span className="opx-num">v{d.version}</span> : <span className="opx-faint">未知</span>) },
            { title: "登录于", width: 130, className: "num", render: (_, d) => <span className="opx-muted">{dayjs(d.createdAt).format("MM-DD HH:mm")}</span> },
            { title: "最近使用", width: 110, render: (_, d) => <span className="opx-muted">{何时(d.lastUsedAt)}</span> },
            {
              title: "状态",
              width: 90,
              render: (_, d) => (d.revoked ? <span className="opx-tag opx-tag-dead">已吊销</span> : <span className="opx-tag opx-tag-ok">在用</span>),
            },
          ]}
        />
      </卡片>

      <div className="opx-grid opx-grid-11">
        <卡片 标题="次数是怎么来的" 说明="赠送流水，新的在上" 平>
          <Table
            rowKey="id"
            size="small"
            dataSource={详情.赠送流水}
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            locale={{ emptyText: <div className="opx-empty">还没有赠送记录</div> }}
            columns={[
              { title: "时间", width: 120, className: "num", render: (_, g: 用户详情["赠送流水"][number]) => <span className="opx-muted">{dayjs(g.at).format("MM-DD HH:mm")}</span> },
              { title: "来路", render: (_, g: 用户详情["赠送流水"][number]) => g.来路 },
              { title: "次数", width: 70, className: "num", render: (_, g: 用户详情["赠送流水"][number]) => <b style={{ color: "var(--x-ok)" }}>+{g.数}</b> },
              { title: "备注", render: (_, g: 用户详情["赠送流水"][number]) => <span className="opx-muted">{g.note ?? ""}</span> },
            ]}
          />
        </卡片>

        <卡片 标题="他发过的反馈" 右={<Link href={站内(token, "/feedback")} style={{ fontSize: 12.5 }}><LinkPending />全部反馈 →</Link>}>
          {详情.反馈.length ? (
            详情.反馈.map((f) => (
              <div key={f.id} className={`opx-fb ${f.handled ? "opx-fb-done" : "opx-fb-todo"}`}>
                <div className="opx-fb-h">
                  <span>{dayjs(f.at).format("MM-DD HH:mm")}</span>
                  {f.version && <span>v{f.version}</span>}
                  {f.path && <span className="opx-mono">{f.path}</span>}
                  <span style={{ marginLeft: "auto" }} className={`opx-tag${f.handled ? "" : " opx-tag-blue"}`}>
                    {f.handled ? "处理过了" : "没处理"}
                  </span>
                </div>
                <p>{f.body}</p>
              </div>
            ))
          ) : (
            <div className="opx-empty">还没发过反馈</div>
          )}
        </卡片>
      </div>
    </>
  );
}
