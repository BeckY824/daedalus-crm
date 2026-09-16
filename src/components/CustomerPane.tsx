"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Tag } from "antd";
import { SearchOutlined, TableOutlined } from "@ant-design/icons";
import { FOLLOW_STATUSES, FOLLOW_STATUS_COLOR } from "@/lib/constants";
import { avatarColor, initial, smartTime, AVATAR_TEXT } from "@/lib/utils";
import { useBusiness } from "@/lib/business-client";
import { statusLabel } from "@/lib/business-config";

export type CustomerPaneData = {
  total: number;
  rows: { id: string; name: string; followStatus: string; lastFollowAt: string | null; ownerName: string; lastNote: string | null }[];
};

/**
 * 学员模块的中栏：最近跟进过的一列，点一行右栏出档案。
 * 只装最近 50 位；搜索和状态筛选在这 50 位里做，要翻全量去右栏的表格（图标栏旁那个「表格」入口）。
 * 它不替代表格视图，是给「我今天要找那几个人」这个动作的快路。
 */
export default function CustomerPane({ data }: { data: CustomerPaneData }) {
  const b = useBusiness();
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("");
  const activeId = pathname.startsWith("/customers/") ? pathname.split("/")[2] : "";

  const rows = useMemo(() => {
    const k = q.trim();
    return data.rows.filter((r) => (!status || r.followStatus === status) && (!k || r.name.includes(k) || (r.lastNote ?? "").includes(k)));
  }, [data.rows, q, status]);

  // 只摆用到的状态：50 位里没有的状态不占一个筛选条
  const 状态们 = useMemo(() => FOLLOW_STATUSES.filter((s) => data.rows.some((r) => r.followStatus === s)), [data.rows]);

  return (
    <>
      <div className="pane-h">
        <span className="pane-t">
          {b.customer}
          <span className="pane-n">{data.total}</span>
        </span>
        <Link href="/customers" className={`pane-ib${pathname === "/customers" ? " on" : ""}`} aria-label={`${b.customer}表格`} title="表格视图">
          <TableOutlined />
        </Link>
      </div>
      <div className="pane-search">
        <SearchOutlined style={{ color: "#9ca3af" }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`搜姓名、最近一句`}
          aria-label={`搜索${b.customer}`}
          onKeyDown={(e) => {
            // 这 50 位里没有的，回车去全量表格里搜
            if (e.key === "Enter" && q.trim() && rows.length === 0) router.push(`/customers?keyword=${encodeURIComponent(q.trim())}`);
          }}
        />
      </div>
      {状态们.length > 1 && (
        <div className="pane-chips">
          <button type="button" className={`pane-chip${status === "" ? " on" : ""}`} onClick={() => setStatus("")}>
            全部
          </button>
          {状态们.map((s) => (
            <button key={s} type="button" className={`pane-chip${status === s ? " on" : ""}`} onClick={() => setStatus(status === s ? "" : s)}>
              {statusLabel(b, s)}
            </button>
          ))}
        </div>
      )}
      <div className="pane-rows">
        {rows.length === 0 && (
          <div className="pane-empty">
            {q
              ? "这 50 位里没有，回车去全量里搜"
              : status
                ? `这 50 位里没有「${statusLabel(b, status)}」的`
                : /* 一条都没有 ≠ 筛完没有。空库时说「还没有这个状态的」是句错话 */
                  `还没有${b.customer}`}
          </div>
        )}
        {rows.map((r) => (
          <Link key={r.id} href={`/customers/${r.id}`} className={`pane-row${activeId === r.id ? " on" : ""}`}>
            <span className="pane-avatar" style={{ background: avatarColor(r.name), color: AVATAR_TEXT }}>
              {initial(r.name)}
            </span>
            <span className="pane-row-m">
              <span className="pane-row-n">
                {r.name}
                <Tag color={FOLLOW_STATUS_COLOR[r.followStatus] ?? "default"} style={{ margin: 0, borderRadius: 5, fontSize: 11.5, lineHeight: "18px", padding: "0 5px" }}>
                  {statusLabel(b, r.followStatus)}
                </Tag>
              </span>
              <span className="pane-row-s">{r.lastNote ?? `还没跟进 · ${r.ownerName}`}</span>
            </span>
            <span className="pane-row-r">{r.lastFollowAt ? smartTime(r.lastFollowAt) : ""}</span>
          </Link>
        ))}
        {data.total > data.rows.length && (
          <Link href="/customers" className="pane-more">
            这里只有最近 {data.rows.length} 位，全部 {data.total} 位在表格里 ›
          </Link>
        )}
      </div>
    </>
  );
}
