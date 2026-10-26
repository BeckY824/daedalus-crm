"use client";

import { useRouter } from "next/navigation";
import { Button, Select, Space, Segmented, Tag } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { PageHead, CustomerLink, UserCell } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
import ListSearch from "@/components/ListSearch";
import ResetFilters from "@/components/ResetFilters";
import { useBusiness } from "@/lib/business-client";
import { useLocalPref } from "@/lib/local-pref";
import { useUrlFilters } from "@/lib/url-filters";
import { 列表不问归属ID } from "@/lib/solo";
import { fmtDate, 成员选项, type 可选成员 } from "@/lib/utils";
import { 金额, 合计文字 } from "@/lib/currency";
import { 主题颜色 } from "@/lib/chart-theme";
import { categorical } from "@/lib/palette";
import type { 项目行, 看板一列 } from "@/lib/project/board";
import type { 看板列 } from "@/lib/project/nodes";
import InviteInbox, { type 邀请行 } from "./InviteInbox";

/** 看板五列的颜色：三个阶段沿用商机管道的蓝绿黄，成功交付粉、没成灰 */
const 列色: Record<看板列, string> = {
  线索: 主题颜色(categorical.blue),
  商机: 主题颜色(categorical.green),
  订单: 主题颜色(categorical.yellow),
  成功交付: 主题颜色(categorical.pink),
  没成: "var(--line-strong)",
};

const 空列说法: Record<看板列, string> = {
  线索: "还没有在培育的线索",
  商机: "还没有在谈的商机",
  订单: "还没有在交付的订单",
  成功交付: "还没有交付完的项目",
  没成: "没有流失或丢掉的项目",
};

/** 异常的悬停说明：类别 + 备注 */
function 异常说明(r: 项目行) {
  return [r.exceptionCategory, r.exceptionReason].filter(Boolean).join("：") || undefined;
}

/** 节点那一格：有结局写结局，异常标红 */
function 节点文字(r: 项目行) {
  if (r.result === "异常状态") return <Tag color="error" title={异常说明(r)}>异常 · {r.exceptionCategory ?? r.node}</Tag>;
  if (r.result) return <Tag>{r.result}</Tag>;
  return <span>{r.phase} · {r.node}</span>;
}

/**
 * 项目页（团队版项目模式 1a）：列表和看板两种看法，同一批行、同一组筛选。
 * 看板列头写项目数和按币种分开的金额合计；异常状态的项目留在订单列、左边框标红
 */
export default function ProjectsView({
  行, 列: 看板, 取到上限, users, filters, 邀请们 = [],
}: {
  行: 项目行[];
  列: 看板一列[];
  取到上限: boolean;
  users: 可选成员[];
  filters: { keyword: string; ownerId: string; pool: string };
  /** 企业版：等我回的项目组邀请（别的版本是空的） */
  邀请们?: 邀请行[];
}) {
  const router = useRouter();
  const b = useBusiness();
  const [看法, set看法] = useLocalPref<"列表" | "看板">("projects-view", "看板");
  const { f, setF, apply, reset, pending } = useUrlFilters("/projects", filters);
  const 不问归属 = !f.ownerId && 列表不问归属ID(users, 行.map((r) => r.ownerId));
  const 在筛 = Object.values(filters).some(Boolean);
  const 新建 = () => router.push("/projects/new");
  // 公海里同事客户的项目不给客户名（page.tsx 露客户），领取后再看
  const 领了再看 = `领取后显示${b.customer}`;

  const 列表: 列<项目行>[] = [
    { title: "项目", dataIndex: "name", width: 200, ellipsis: true },
    { title: b.customer, key: "customer", width: 180, render: (_, r) => (r.customerName == null ? <span style={{ color: "var(--text-muted)" }}>{领了再看}</span> : <CustomerLink id={r.customerId} name={r.customerName} />) },
    { title: "节点", key: "node", width: 170, render: (_, r) => 节点文字(r) },
    { title: "金额", key: "amount", width: 130, align: "right", render: (_, r) => 金额(r.amount, r.currency) },
    ...(不问归属 ? [] : [{ title: "负责人", key: "owner", width: 110, render: (_: unknown, r: 项目行) => (r.pooled ? <Tag title={`${r.ownerName} 放回的`}>公海</Tag> : <UserCell name={r.ownerName} />) }]),
    { title: "最近更新", key: "updatedAt", width: 120, render: (_, r) => fmtDate(r.updatedAt) },
  ];

  const 筛选 = (
    <Space wrap size={[10, 10]}>
      <ListSearch
        width={240}
        placeholder={`项目名称 / ${b.customer}`}
        value={f.keyword}
        onChange={(v) => setF({ ...f, keyword: v })}
        onSearch={(v) => apply({ keyword: v })}
      />
      {!不问归属 && (
        <Select
          style={{ width: 126 }}
          placeholder="全部成员"
          allowClear
          value={f.ownerId || undefined}
          onChange={(v) => apply({ ownerId: v ?? "" })}
          options={成员选项(users)}
        />
      )}
      <Select
        style={{ width: 120 }}
        aria-label="项目公海"
        value={f.pool || ""}
        onChange={(v: string) => apply({ pool: v })}
        options={[{ value: "", label: "全部项目" }, { value: "1", label: "项目公海" }]}
      />
      <ResetFilters 显示={Object.values(f).some(Boolean)} onClick={reset} />
    </Space>
  );

  return (
    <div>
      <PageHead
        title="项目"
        subtitle={取到上限 ? "只显示最近改过的 500 个项目，用搜索找更早的" : "从线索到交付，一个项目一条线"}
        extra={
          <Space>
            <Segmented<"列表" | "看板"> options={["看板", "列表"]} value={看法} onChange={set看法} />
            <Button type="primary" icon={<PlusOutlined />} onClick={新建}>新建项目</Button>
          </Space>
        }
      />

      <InviteInbox 邀请们={邀请们} />

      {看法 === "列表" ? (
        <DataList<项目行>
          页="projects"
          列={列表}
          行={行}
          空库={行.length === 0 && !在筛}
          加载中={pending}
          行链接={(r) => `/projects/${r.id}`}
          空态={{
            title: "还没有项目",
            hint: `项目是跟一位${b.customer}做的一件事：从线索培育一路走到交付。新建时会一起建好${b.customer}、联系人和第一次沟通。`,
            primary: { label: "新建第一个项目", onClick: 新建 },
          }}
          筛选={筛选}
        />
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>{筛选}</div>
          <div className="pipe-wrap">
            <div className="pipe">
              {看板.map((c) => {
                const sum = 合计文字(c.合计, b.currency);
                return (
                  <div key={c.列} className="pipe-col" aria-label={`${c.列}，${c.数} 个项目`}>
                    <div className="pipe-h">
                      <span className="pipe-dot" style={{ background: 列色[c.列] }} />
                      <b>{c.列}</b>
                      <span className="pipe-n">{c.数}</span>
                      <span className="pipe-sum" title={sum}>{sum}</span>
                    </div>
                    <div className="pipe-bar" style={{ background: 列色[c.列] }} />
                    {c.行.length === 0 && <div className="pipe-empty">{在筛 ? "这一列没有对上的" : 空列说法[c.列]}</div>}
                    {c.行.map((r) => {
                      const 异常 = r.result === "异常状态";
                      return (
                        <div
                          key={r.id}
                          className="pipe-card"
                          style={{ borderLeftColor: 异常 ? "var(--danger)" : 列色[c.列] }}
                          tabIndex={0}
                          role="link"
                          title={异常 && 异常说明(r) ? `异常：${异常说明(r)}` : `${r.customerName ?? 领了再看} · ${r.node}`}
                          aria-label={`${r.name}，${r.customerName ?? 领了再看}，${异常 ? "异常 · " : ""}${r.node}，${金额(r.amount, r.currency)}${r.pooled ? "，在项目公海里" : ""}`}
                          onClick={() => router.push(`/projects/${r.id}`)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              router.push(`/projects/${r.id}`);
                            }
                          }}
                        >
                          <div className="pipe-card-t">{r.name}</div>
                          <div className="pipe-card-m">
                            <span className="pipe-card-o" style={r.customerName == null ? { color: "var(--text-muted)" } : undefined}>{r.customerName ?? 领了再看}</span>
                          </div>
                          <div className="pipe-card-m">
                            <span className="pipe-card-o" style={异常 ? { color: "var(--danger-text)" } : undefined}>
                              {异常 ? `异常 · ${r.exceptionCategory ? `${r.exceptionCategory} · ` : ""}` : r.result && r.result !== "成功交付" ? `${r.result} · ` : ""}{r.node}
                            </span>
                            <span className="pipe-card-a">{金额(r.amount, r.currency)}</span>
                          </div>
                          {r.pooled ? (
                            <div className="pipe-card-m"><span className="pipe-card-o"><Tag style={{ marginInlineEnd: 0 }}>公海</Tag></span></div>
                          ) : (
                            !不问归属 && <div className="pipe-card-m"><span className="pipe-card-o">{r.ownerName}</span></div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
