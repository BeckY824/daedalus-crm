"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Input, Table } from "antd";
import { 页头, 站内, 等待中 } from "../OpsShell";
import { 卡片 } from "../ui";
import { AddCreditButtons } from "./AddCredits";
import { CreditLog } from "./CreditLog";
import type { 次数行, 加次记录行 } from "@/lib/tenant/admin-credits";

/** 带上搜索词的站内地址：站内() 已经可能带了 ?token=，再接 & */
const 带词 = (token: string, q: string) => {
  const 址 = 站内(token, "/credits");
  return q ? `${址}${址.includes("?") ? "&" : "?"}q=${encodeURIComponent(q)}` : 址;
};

/** 余额那一格：测试号写「不限」 */
const 剩 = (r: 次数行, k: "背调" | "ai") =>
  r.测试 ? <span className="opx-faint">不限</span> : <span className="opx-two num"><b>{r[k].剩}</b><small>送 {r[k].送} · 用 {r[k].用}</small></span>;

/**
 * 次数（2026-10-19）。用户原话：「如果有用户和我购买了次数，我可以手动添加。包括AI次数……个人版就单独做一个页面做这个。」
 * 按邮箱 / 名字 / 手机搜到人，每行直接「背调 +N」「AI +N」，写一句备注（微信转账 10 次）。团队成员在「团队同步」点进团队加。
 */
export default function CreditsView({ token, q, rows, 记录 }: { token: string; q: string; rows: 次数行[]; 记录: 加次记录行[] }) {
  const router = useRouter();
  const [词, set词] = useState(q);
  const [搜中, 开始] = useTransition();
  return (
    <>
      <页头 标题="次数" 说明="个人版手动加背调次数 / AI 次数：客户私下买了次数，这里搜到人直接加。只加不减，每次都留记录。团队成员在「团队同步」点进团队加" />
      <卡片
        标题={q ? `搜「${q}」` : "最近注册的 20 个"}
        说明={q ? `${rows.length} 个账号${rows.length === 50 ? "（只列前 50 个，写具体点）" : ""}` : "按邮箱、名字或手机搜"}
        右={
          <Input.Search
            allowClear
            value={词}
            onChange={(e) => set词(e.target.value)}
            onSearch={(v) => 开始(() => router.push(带词(token, v.trim())))}
            loading={搜中}
            placeholder="邮箱 / 名字 / 手机"
            aria-label="搜账号"
            style={{ width: 280 }}
          />
        }
        平
      >
        {搜中 && <等待中 />}
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={rows}
          className="opx-credit-accounts"
          locale={{ emptyText: <div className="opx-empty">{q ? "没搜到，换个词试试（邮箱、名字、手机都行）" : "还没有账号"}</div> }}
          columns={[
            {
              title: "账号", key: "a",
              render: (_, r) => (
                <Link href={站内(token, `/users/${r.id}`)} className="opx-two">
                  <span>{r.name}</span>
                  <small>{r.email ?? r.phone ?? ""}</small>
                </Link>
              ),
            },
            { title: "背调剩", key: "r", width: 120, render: (_, r) => 剩(r, "背调") },
            { title: "AI 剩", key: "i", width: 120, render: (_, r) => 剩(r, "ai") },
            { title: "", key: "act", width: 200, render: (_, r) => <AddCreditButtons token={token} account={r} /> },
          ]}
        />
      </卡片>
      <卡片 标题="加次记录" 说明="运营台加的次数，新的在上（最近 100 条）" 平>
        <CreditLog token={token} rows={记录} />
      </卡片>
    </>
  );
}
