"use client";
import dayjs from "dayjs";
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
import { 开名单, 关名单, useRosterOpen, useRosterInDrawer, 登记换一位 } from "@/lib/roster";
import { useLocalPref } from "@/lib/local-pref";

export type CustomerRosterData = {
  total: number;
  rows: {
    id: string;
    name: string;
    followStatus: string;
    lastFollowAt: string | null;
    ownerName: string;
    lastNote: string | null;
    /** 我名下的（「我的」页签） */
    mine?: boolean;
    /** 卡片第一行：从哪儿来（渠道 / 转介绍 / 最近一次怎么联系的），见 @pane/panes.tsx */
    source?: string | null;
    /** 最近一条还没做的计划：「本周要跟」和右下角圆点看它 */
    nextPlanAt?: string | null;
  }[];
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
  const 抽屉里 = useRosterInDrawer();
  const 抽屉开着 = useRosterOpen();
  const 搜索框 = useRef<HTMLInputElement>(null);
  const activeId = pathname.startsWith("/customers/") ? pathname.split("/")[2] : "";

  const rows = useMemo(() => {
    const k = q.trim();
    return data.rows.filter((r) => !k || r.name.includes(k) || (r.lastNote ?? "").includes(k));
  }, [data.rows, q]);

  /*
    按跟进状态分组、组可以折叠（2026-10-02，学 MonoCode 的会话列表）：50 位挤成一列时，
    「哪些人在谈、哪些人睡着了」得一位位看标签才分得出；分了组，组头带人数，不想看的那组一收。
    只在没搜、没筛的时候分组——搜和筛本身就是在挑人，再分组是叠床架屋。折叠记在这台电脑上。
  */
  const [收起的, set收起的] = useLocalPref<string[]>("roster.collapsed", []);
  /*
    页签（照毛玻璃原型）：全部 / 我的 / 本周要跟。「我的」只在名单里真有别人的客户时才出现——
    桌面端就你一个人，「全部」和「我的」是同一张单子，摆两个一样的页签是让人找不同。
    「本周要跟」= 计划排在七天之内的，已经过期没做的也算（那更该跟）。
  */
  const [页签, set页签] = useState<"全部" | "我的" | "本周">("全部");
  const 有别人的 = data.rows.some((r) => r.mine === false);
  const 七天后 = dayjs().add(7, "day").endOf("day");
  const 当前页签 = 页签 === "我的" && !有别人的 ? "全部" : 页签;
  const 页签里 = useMemo(
    () =>
      rows.filter((r) =>
        当前页签 === "我的" ? r.mine !== false : 当前页签 === "本周" ? Boolean(r.nextPlanAt && dayjs(r.nextPlanAt).isBefore(七天后)) : true,
      ),
    // 七天后 每次渲染都新算，按天变就够了，不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, 当前页签],
  );
  const 分组 = !q.trim();
  const 组们 = useMemo(
    () => FOLLOW_STATUSES.map((s) => ({ s, rows: 页签里.filter((r) => r.followStatus === s) })).filter((g) => g.rows.length > 0),
    [页签里],
  );
  const 切组 = (s: string) => set收起的(收起的.includes(s) ? 收起的.filter((x) => x !== s) : [...收起的, s]);


  /**
   * ⌘K：光标进搜索框（窄屏时先把抽屉打开）。记录页上「换一个人」是最常用的动作，值得一个快捷键。
   * 键本身由 CommandBar 听，这里只登记「⌘K 在这一页是什么意思」（lib/roster.ts 的 登记换一位，审查 M8）
   */
  useEffect(
    () =>
      登记换一位(() => {
        if (抽屉里) return 开名单();
        搜索框.current?.focus();
        搜索框.current?.select();
      }),
    [抽屉里],
  );

  // 抽屉一打开就把光标放进搜索框——打开它就是为了找人
  useEffect(() => {
    if (抽屉开着) setTimeout(() => 搜索框.current?.focus(), 80);
  }, [抽屉开着]);

  /**
   * 一行三层（照毛玻璃原型）：从哪儿来 · 时间 / 名字 / 最近一句 · 圆点。
   * 圆点只有三种：橙 = 计划到期了（今天或更早），灰 = 一个月没动静，绿 = 正常。
   * 分组时状态已经写在组头上，行里不再挂标签；搜索时没有组头，标签补回来。
   */
  const 今天末 = dayjs().endOf("day");
  const 点 = (r: CustomerRosterData["rows"][number]) =>
    r.nextPlanAt && dayjs(r.nextPlanAt).isBefore(今天末)
      ? { cls: "due", 说: "计划的跟进到期了" }
      : !r.lastFollowAt || dayjs().diff(dayjs(r.lastFollowAt), "day") >= 30
        ? { cls: "cold", 说: "一个月没跟进了" }
        : { cls: "ok", 说: "最近跟进过" };
  const 一行 = (r: CustomerRosterData["rows"][number], 带状态: boolean) => {
    const d = 点(r);
    return (
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
          <span className="roster-l0">
            <span className="roster-src">
              {带状态 && (
                <Tag color={FOLLOW_STATUS_COLOR[r.followStatus] ?? "default"} style={{ margin: "0 6px 0 0", borderRadius: 5, fontSize: 12, lineHeight: "18px", padding: "0 5px" }}>
                  {statusLabel(b, r.followStatus)}
                </Tag>
              )}
              {r.source ?? ""}
            </span>
            <span className="roster-t">{r.lastFollowAt ? smartTime(r.lastFollowAt) : ""}</span>
          </span>
          <span className="roster-n">{r.name}</span>
          <span className="roster-l2">
            <span className="roster-note">{r.lastNote ?? `还没跟进 · ${r.ownerName}`}</span>
            <span className={`roster-dot ${d.cls}`} title={d.说} aria-label={d.说} />
          </span>
        </span>
      </Link>
    );
  };

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
      <div className="roster-tabs" role="tablist" aria-label={`${b.customer}名单`}>
        {(有别人的 ? (["全部", "我的", "本周"] as const) : (["全部", "本周"] as const)).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={当前页签 === t} className={`roster-tab${当前页签 === t ? " on" : ""}`} onClick={() => set页签(t)}>
            {t === "本周" ? "本周要跟" : t}
          </button>
        ))}
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
      {/* 原来这里有一排状态筛选（全部 / 待跟进 / 跟进中…）。分组以后它和组头说的是同一件事，
          想只看一种就把别的组收起来——同一个功能摆两套入口是在让人选一个不存在的区别（2026-10-02） */}
      <div className="pane-rows">
        {页签里.length === 0 && (
          <div className="pane-empty">
            {q
              ? "这 50 位里没有，回车去全量里搜"
              : 当前页签 === "本周"
                ? "这一周没有排好的跟进"
                : 当前页签 === "我的"
                  ? `名下还没有${b.customer}`
                  : /* 一条都没有 ≠ 搜完没有。空库时说「没搜到」是句错话 */
                    `还没有${b.customer}`}
          </div>
        )}
        {分组
          ? 组们.map((g) => {
              const 开 = !收起的.includes(g.s);
              return (
                <div key={g.s} className="roster-group">
                  <button type="button" className="roster-sec" aria-expanded={开} onClick={() => 切组(g.s)}>
                    <span className="roster-car" aria-hidden="true">▾</span>
                    {statusLabel(b, g.s)}
                    <span className="roster-cnt">{g.rows.length}</span>
                  </button>
                  {开 && g.rows.map((r) => 一行(r, false))}
                </div>
              );
            })
          : 页签里.map((r) => 一行(r, true))}
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
