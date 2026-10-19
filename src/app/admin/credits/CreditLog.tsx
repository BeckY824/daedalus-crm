"use client";

import Link from "next/link";
import { Table, Tag } from "antd";
import { dayjs } from "@/lib/utils";
import { 站内 } from "../OpsShell";
import type { 加次记录行 } from "@/lib/tenant/admin-credits";

/** 运营台加次记录（次数页、团队详情页共用）：什么时候、给谁、加了几次什么、谁加的、备注。10-19 之前加的没记是谁，写「—」 */
export function CreditLog({ token, rows, 显示账号 = true }: { token: string; rows: 加次记录行[]; 显示账号?: boolean }) {
  return (
    <Table
      rowKey="key"
      size="small"
      pagination={rows.length > 20 ? { pageSize: 20, size: "small" } : false}
      dataSource={rows}
      className="opx-credit-log"
      locale={{ emptyText: <div className="opx-empty">还没有加过次数</div> }}
      columns={[
        { title: "时间", key: "at", width: 130, render: (_, r) => <span className="num opx-muted opx-nowrap">{dayjs(r.at).format("MM-DD HH:mm")}</span> },
        ...(显示账号
          ? [{ title: "账号", key: "a", render: (_: unknown, r: 加次记录行) => <Link href={站内(token, `/users/${r.accountId}`)}>{r.账号}</Link> }]
          : [{ title: "账号", key: "a", render: (_: unknown, r: 加次记录行) => r.账号 }]),
        { title: "加了", key: "n", width: 110, render: (_, r) => <span className="opx-nowrap"><Tag color={r.种类 === "research" ? "purple" : "blue"}>{r.种类 === "research" ? "背调" : "AI"}</Tag><b className="num" style={{ color: "var(--x-ok)" }}>+{r.数}</b></span> },
        { title: "谁加的", key: "by", width: 170, render: (_, r) => (r.by ? <span>{r.by}</span> : <span className="opx-faint" title="10-19 之前加的，没记是谁">—</span>) },
        { title: "备注", key: "note", render: (_, r) => <span className="opx-muted">{[r.团队 ? `团队「${r.团队}」` : "", r.note ?? ""].filter(Boolean).join(" · ")}</span> },
      ]}
    />
  );
}
