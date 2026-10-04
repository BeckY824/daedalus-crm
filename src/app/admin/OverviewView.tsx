"use client";

import Link from "next/link";
import {
  DesktopOutlined,
  ExclamationCircleOutlined,
  MessageOutlined,
  RiseOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import Chart from "@/components/Chart";
import { 分布说法 } from "@/lib/device-os";
import { 站内, 页头, LinkPending } from "./OpsShell";
import { Kpi, 卡片, 按天柱图, 横条图, 头像, 何时, 千分位, 次数条, 系统们, 系统分段 } from "./ui";
import type { 总览数 } from "./data";

const 用完了 = (a: { ai: { 送: number; 剩: number } }) => a.ai.送 > 0 && a.ai.剩 === 0;

/**
 * 总览。三层：顶上六个数（前四个是「有多少」，后两个是「要不要动手」，后者为 0 才算太平）→
 * 两行图（AI 调用、设备；新注册、功能）→ 三张清单（需要关注、最近注册、最新反馈），每一条都点得进去。
 *
 * 这一页的人数、设备、调用都只算真实用户：测试账号（含运营账号）在 data.ts 里就拿掉了，只在页头说一句有几个。
 */
export default function OverviewView({ token, 数 }: { token: string; 数: 总览数 }) {
  const 账号 = 数.账号;
  const 共 = 账号.length;
  const 设备共 = 数.设备.Mac + 数.设备.Windows + 数.设备.Linux + 数.设备.未知;
  const 卡住的 = 账号.filter(用完了).sort((a, b) => (b.最近活跃 ?? "").localeCompare(a.最近活跃 ?? ""));
  const 最近注册 = [...账号].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);

  return (
    <>
      <页头
        标题="总览"
        说明={`注册的人、他们的设备、AI 用了多少、有什么要动手的——都在这一页${数.测试账号数 ? `。测试账号 ${数.测试账号数} 个（含运营账号）不算在内` : ""}`}
      />

      <div className="opx-kpis">
        <Kpi 名="注册用户" icon={<TeamOutlined />} 数={共} 注={`近 7 天新增 ${数.新注册7天} 个`} />
        <Kpi 名="近 7 天活跃" icon={<RiseOutlined />} 数={数.活跃7天} 注={共 ? `占全部的 ${Math.round((数.活跃7天 / 共) * 100)}%` : "还没有人注册"} />
        <Kpi 名="桌面端设备" icon={<DesktopOutlined />} 数={设备共} 尾="台" 注={设备共 ? 分布说法(数.设备) : "还没有人登录过桌面端"} />
        <Kpi 名="近 30 天模型调用" icon={<ThunderboltOutlined />} 数={数.调用30天} 尾="次" 注={`共 ${千分位(数.token30天)} token`} />
        <Kpi
          名="次数用完"
          icon={<ExclamationCircleOutlined />}
          数={卡住的.length}
          尾="人"
          注={卡住的.length ? "他问不了了，也不会来说" : "没有人卡在额度上"}
          警={卡住的.length > 0}
          静={卡住的.length === 0}
        />
        <Kpi
          名="待处理反馈"
          icon={<MessageOutlined />}
          数={数.反馈.没处理}
          尾="条"
          注={数.反馈.没处理 ? "有人在等回音" : "都处理过了"}
          警={数.反馈.没处理 > 0}
          静={数.反馈.没处理 === 0}
        />
      </div>

      <div className="opx-grid opx-grid-21">
        <卡片 标题="模型调用" 说明="近 30 天，每天多少次；悬停看 token">
          <Chart option={按天柱图(数.调用趋势)} height={240} />
        </卡片>
        <卡片 标题="设备" 说明="还在用的设备，按系统">
          <系统分段 分={数.设备} />
          <div style={{ marginTop: 20, fontSize: 12.5, color: "var(--x-muted)", marginBottom: 4 }}>版本</div>
          {数.版本分布.length ? (
            <>
              <Chart option={横条图(数.版本分布.map((v) => ({ 名: v.版本 === "未知" ? "未知" : `v${v.版本}`, 数: v.台数 })), "台")} height={Math.max(90, 数.版本分布.length * 30 + 10)} />
              {数.版本分布.some((v) => v.版本 === "未知") && (
                <div style={{ fontSize: 12, color: "var(--x-faint)", marginTop: 4 }}>未知 = 0.46.6 及以前装的，升级之后下次打开就报上来</div>
              )}
            </>
          ) : (
            <div className="opx-empty">还没有设备</div>
          )}
        </卡片>
      </div>

      <div className="opx-grid opx-grid-21">
        <卡片 标题="新注册" 说明="近 30 天，每天几个">
          <Chart option={按天柱图(数.注册趋势, "个")} height={200} />
        </卡片>
        <卡片 标题="AI 用在哪" 说明="近 30 天，按功能">
          {数.功能分布.length ? (
            <Chart option={横条图(数.功能分布.map((f) => ({ 名: f.功能, 数: f.次数 })))} height={Math.max(120, 数.功能分布.length * 30 + 10)} />
          ) : (
            <div className="opx-empty">这 30 天没有调用</div>
          )}
        </卡片>
      </div>

      <div className="opx-grid opx-grid-111">
        <卡片 标题="需要关注" 说明="次数用完的人">
          {卡住的.length ? (
            <div className="opx-list">
              {卡住的.slice(0, 6).map((a) => (
                <Link key={a.id} href={站内(token, `/users/${a.id}`)}><LinkPending />
                  <头像 名={a.name} />
                  <span className="opx-who">
                    <span style={{ minWidth: 0 }}>
                      <b>{a.name}</b>
                      <small>最近活跃 {何时(a.最近活跃)}</small>
                    </span>
                  </span>
                  <span className="opx-list-r">
                    <次数条 剩={a.ai.剩} 送={a.ai.送} />
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="opx-empty">没有人卡在额度上</div>
          )}
        </卡片>

        <卡片 标题="最近注册" 右={<Link href={站内(token, "/users")} style={{ fontSize: 12.5 }}><LinkPending />全部用户 →</Link>}>
          {最近注册.length ? (
            <div className="opx-list">
              {最近注册.map((a) => (
                <Link key={a.id} href={站内(token, `/users/${a.id}`)}><LinkPending />
                  <头像 名={a.name} />
                  <span className="opx-who">
                    <span style={{ minWidth: 0 }}>
                      <b>{a.name}</b>
                      <small>
                        <系统们 分={a.分布} />
                      </small>
                    </span>
                  </span>
                  <span className="opx-list-r">{何时(a.createdAt)}</span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="opx-empty">还没有人注册</div>
          )}
        </卡片>

        <卡片 标题="最新反馈" 右={<Link href={站内(token, "/feedback")} style={{ fontSize: 12.5 }}><LinkPending />全部反馈 →</Link>}>
          {数.反馈.最新.length ? (
            <div className="opx-list">
              {数.反馈.最新.map((f) => (
                <Link key={f.id} href={站内(token, "/feedback")} style={{ alignItems: "flex-start" }}><LinkPending />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <b style={{ fontSize: 13 }}>{f.who || "（不知道是谁）"}</b>
                    <span
                      style={{ display: "block", fontSize: 12.5, color: "var(--x-ink-2)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {f.body}
                    </span>
                  </span>
                  <span className="opx-list-r">{何时(f.at)}</span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="opx-empty">没有待处理的反馈</div>
          )}
        </卡片>
      </div>
    </>
  );
}
