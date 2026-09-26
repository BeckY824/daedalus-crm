"use client";
import Shortcut from "./Shortcut";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Tag, Drawer } from "antd";
import { SearchOutlined, TableOutlined } from "@ant-design/icons";
import { FOLLOW_STATUSES, FOLLOW_STATUS_COLOR } from "@/lib/constants";
import { avatarColor, initial, smartTime, AVATAR_TEXT } from "@/lib/utils";
import { useBusiness } from "@/lib/business-client";
import { statusLabel } from "@/lib/business-config";
import { 开名单, 关名单, useRosterOpen, useRosterInDrawer } from "@/lib/roster";

export type CustomerRosterData = {
  total: number;
  rows: { id: string; name: string; followStatus: string; lastFollowAt: string | null; ownerName: string; lastNote: string | null }[];
};

/**
 * 记录页左边的窄名单：最近跟进过的 50 位，点一行就换人看。
 *
 * **它只在记录页出现，列表页没有**（批 2）。列表页已经是一张全宽的表，
 * 旁边再挂一条同样内容的名单，是把同一件事画两遍；而记录页缺的恰恰是
 * 「换一个人」这条路——原来从林夏切到陈航要退回列表再进去。
 *
 * 窄到 1440 以下时它收成抽屉，由记录页页头上那个按钮开（见 lib/roster.ts）：
 * 名单 220 + 档案 264 + 时间线 + AI 340 在 164 的左栏旁边，1440 是下限。
 *
 * 只装最近 50 位；搜索和状态筛选在这 50 位里做，要翻全量按回车去表格。
 */
export default function CustomerRoster({ data }: { data: CustomerRosterData }) {
  const b = useBusiness();
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("");
  const 抽屉里 = useRosterInDrawer();
  const 抽屉开着 = useRosterOpen();
  const 搜索框 = useRef<HTMLInputElement>(null);
  const activeId = pathname.startsWith("/customers/") ? pathname.split("/")[2] : "";

  const rows = useMemo(() => {
    const k = q.trim();
    return data.rows.filter((r) => (!status || r.followStatus === status) && (!k || r.name.includes(k) || (r.lastNote ?? "").includes(k)));
  }, [data.rows, q, status]);

  // 只摆用到的状态：50 位里没有的状态不占一个筛选条
  const 状态们 = useMemo(() => FOLLOW_STATUSES.filter((s) => data.rows.some((r) => r.followStatus === s)), [data.rows]);

  /** ⌘K：光标进搜索框。记录页上「换一个人」是最常用的动作，值得一个快捷键 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (抽屉里) return 开名单();
        搜索框.current?.focus();
        搜索框.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [抽屉里]);

  // 抽屉一打开就把光标放进搜索框——打开它就是为了找人
  useEffect(() => {
    if (抽屉开着) setTimeout(() => 搜索框.current?.focus(), 80);
  }, [抽屉开着]);

  const 内容 = (
    <>
      <div className="pane-h">
        <span className="pane-t">
          {b.customer}
          <span className="pane-n">{data.total}</span>
        </span>
        <Link href="/customers" className="pane-ib" aria-label={`${b.customer}表格`} title="表格视图">
          <TableOutlined />
        </Link>
      </div>
      <div className="pane-search">
        <SearchOutlined style={{ color: "var(--text-muted)" }} />
        <input
          ref={搜索框}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜姓名、最近一句"
          aria-label={`搜索${b.customer}`}
          onKeyDown={(e) => {
            // 这 50 位里没有的，回车去全量表格里搜
            if (e.key === "Enter" && q.trim() && rows.length === 0) router.push(`/customers?keyword=${encodeURIComponent(q.trim())}`);
          }}
        />
        <kbd className="pane-kbd"><Shortcut>⌘K</Shortcut></kbd>
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
          <Link
            key={r.id}
            href={`/customers/${r.id}`}
            className={`roster-row${activeId === r.id ? " on" : ""}`}
            onClick={() => 抽屉开着 && 关名单()}
          >
            <span className="roster-av" style={{ background: avatarColor(r.name), color: AVATAR_TEXT }}>
              {initial(r.name)}
            </span>
            <span className="roster-m">
              <span className="roster-l1">
                <span className="roster-n">{r.name}</span>
                <span className="roster-t">{r.lastFollowAt ? smartTime(r.lastFollowAt) : ""}</span>
              </span>
              <span className="roster-l2">
                <Tag color={FOLLOW_STATUS_COLOR[r.followStatus] ?? "default"} style={{ margin: 0, borderRadius: 5, fontSize: 12, lineHeight: "18px", padding: "0 5px", flex: "none" }}>
                  {statusLabel(b, r.followStatus)}
                </Tag>
                <span className="roster-note">{r.lastNote ?? `还没跟进 · ${r.ownerName}`}</span>
              </span>
            </span>
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

  if (抽屉里) {
    return (
      <Drawer
        placement="left"
        open={抽屉开着}
        onClose={关名单}
        closable={false}
        /* antd 6 里 Drawer 的 width 废了，宽度改在 wrapper 上给 */
        styles={{ wrapper: { width: 300 }, body: { padding: 0, display: "flex", flexDirection: "column" } }}
        rootClassName="pane-drawer"
      >
        {内容}
      </Drawer>
    );
  }

  return <aside className="pane pane-roster">{内容}</aside>;
}
