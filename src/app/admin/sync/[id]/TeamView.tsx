"use client";

import Link from "next/link";
import { Table, Tag } from "antd";
import { dayjs } from "@/lib/utils";
import { 页头, 站内, LinkPending } from "../../OpsShell";
import { 卡片 } from "../../ui";
import { AddCreditButtons } from "../../credits/AddCredits";
import { CreditLog } from "../../credits/CreditLog";
import type { 团队成员行, 加次记录行 } from "@/lib/tenant/admin-credits";

const 剩 = (r: 团队成员行, k: "背调" | "ai") =>
  r.测试 ? <span className="opx-faint">不限</span> : <span className="opx-two num"><b>{r[k].剩}</b><small>送 {r[k].送} · 用 {r[k].用}</small></span>;

/**
 * 一个团队（2026-10-19）。用户原话：「团队版，最好可以点击进去，里面写清楚团队里的每一个用户，我可以直接增加背调次数+AI次数。」
 * 次数是按人记的（每个成员自己的账号），团队不共用一池子：给谁买的就加给谁。
 */
export default function TeamView({ token, team, rows, 到期, 席位, 记录 }: {
  token: string;
  team: { id: string; name: string; active: boolean; activatedAt: string | null; createdAt: string };
  rows: 团队成员行[];
  到期: { 日: string; 剩: number; 过了: boolean } | null;
  席位: number | null;
  记录: 加次记录行[];
}) {
  const 状态 = team.active && 到期?.过了 ? "已到期" : team.active ? "已开通" : team.activatedAt || 到期 ? "已停用" : "待开通";
  const 说明 = [
    `${rows.length} 个成员${席位 ? ` / ${席位} 席` : ""}`,
    状态,
    到期 ? `到期 ${到期.日}` : team.active ? "未设到期" : "",
    `建于 ${dayjs(team.createdAt).format("YYYY-MM-DD")}`,
  ].filter(Boolean).join(" · ");
  return (
    <>
      <页头
        面包屑={<><Link href={站内(token, "/sync")}><LinkPending />团队同步</Link> / {team.name}</>}
        标题={team.name}
        说明={说明}
      />
      <卡片 标题="成员" 说明="背调 / AI 次数按人记，给谁买的就加给谁；只加不减，每次都留记录。开通 / 续费在「团队同步」列表里" 平>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={rows}
          className="opx-team-members"
          locale={{ emptyText: <div className="opx-empty">团队里没有人了</div> }}
          columns={[
            {
              title: "成员", key: "a",
              render: (_, r) => (
                <Link href={站内(token, `/users/${r.id}`)} className="opx-two">
                  <span>{r.name}</span>
                  <small>{r.email ?? r.phone ?? ""}</small>
                </Link>
              ),
            },
            { title: "角色", key: "role", width: 90, render: (_, r) => (r.role === "owner" ? <Tag color="gold">建的人</Tag> : <Tag>成员</Tag>) },
            { title: "设备", key: "d", width: 70, render: (_, r) => <span className="num">{r.设备} 台</span> },
            { title: "加入", key: "j", width: 106, render: (_, r) => <span className="num opx-nowrap opx-muted">{dayjs(r.joinedAt).format("YYYY-MM-DD")}</span> },
            { title: "背调剩", key: "r", width: 110, render: (_, r) => 剩(r, "背调") },
            { title: "AI 剩", key: "i", width: 110, render: (_, r) => 剩(r, "ai") },
            { title: "", key: "act", width: 200, render: (_, r) => <AddCreditButtons token={token} account={r} teamId={team.id} /> },
          ]}
        />
      </卡片>
      <卡片 标题="加次记录" 说明="这些成员在运营台加过的次数，新的在上" 平>
        <CreditLog token={token} rows={记录} />
      </卡片>
    </>
  );
}
