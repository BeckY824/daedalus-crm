"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Card, InputNumber, Switch, Tag } from "antd";
import { 设配额, 设自动分配参与, type 分配情况 } from "../leads/assign-actions";

/**
 * 设置 → 组织架构 →「线索分配」（企业版 D-38，规则「线索分配和配额」开着才出现）。
 * 一屏看每个能接线索的人：业务线、本月已分 / 配额、当前持有、参与没参与自动分配。
 * - 配额：默认他的直属上级、虚线上级和老板能改，「后台设置谁能改」里可以再勾总管理员等（B2 第 6 条）；空着 = 手动分不限，但不参与自动分配（10-25），0 也不分。
 * - 参与开关：老板、总管理员、销售管理能改（Q-12 默认）；关掉以后自动分配不再挑他，手动分配照常。
 */
export default function LeadAssignCard({ rows }: { rows: 分配情况 }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [忙, set忙] = useState<string | null>(null);
  // 正在改的配额：失焦或回车才存
  const [草稿, set草稿] = useState<Record<string, number | null>>({});
  // 刚拨的参与开关：存成功后和新数据一起换掉，不先弹回旧值（10-25 质量：连着拨要刷新才对）
  const [拨了, set拨了] = useState<Record<string, boolean>>({});
  // 存好到新数据回来之前整张表都别动：这时候页面上还是旧数
  const [刷新中, 开始刷新] = useTransition();
  const 能改参与 = rows.some((r) => r.能改参与);

  const 清 = (id: string) => {
    set草稿(({ [id]: _, ...别的 }) => 别的);
    set拨了(({ [id]: _, ...别的 }) => 别的);
  };
  const 跑 = async (id: string, f: () => Promise<{ ok: boolean; error?: string }>, 成了: string) => {
    set忙(id);
    let ok = false;
    try {
      const r = await f();
      ok = r.ok;
      if (!r.ok) message.error(r.error ?? "没改成，请稍后再试");
      else message.success(成了);
    } catch {
      message.error("没改成，请稍后再试");
    } finally {
      set忙(null);
      // 成了：草稿和新数据同一个过渡里换，新数据到了才一起显示；没成：马上退回页面上的值
      if (ok) 开始刷新(() => { router.refresh(); 清(id); });
      else 清(id);
    }
  };

  const 存配额 = (r: 分配情况[number]) => {
    if (忙 || 刷新中 || !(r.userId in 草稿)) return;
    const v = 草稿[r.userId];
    if (v === r.配额) return set草稿(({ [r.userId]: _, ...别的 }) => 别的);
    void 跑(r.userId, () => 设配额(r.userId, v), v === null ? `${r.name} 的配额清空了，不再参与自动分配` : `${r.name} 的配额改成每月 ${v} 条`);
  };

  return (
    <Card id="lead-assign" title="线索分配" data-testid="org-lead-assign"
      extra={!能改参与 && <span style={{ color: "var(--text-muted)" }}>参与开关只有老板、总管理员、销售管理能改</span>}>
      <p className="muted">
        自动分配在 线索 页点「自动分配」：挑参与的、填了配额、本月没分满的人里「本月已分 / 配额」比例最低的，比例一样先给最早进分配池的。
        没填配额（或填 0）的人不参与自动分配；关掉某人的「参与」也不再自动分给他。手动分配不受这两条影响。分配数每月 1 日清零，持有数不清。
      </p>
      <div style={{ overflowX: "auto" }}>
        <table className="org-field-perm org-lead-assign">
          <thead>
            <tr>
              <th>姓名</th>
              <th>业务线</th>
              <th>本月已分 / 配额</th>
              <th>当前持有</th>
              <th>参与自动分配</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const 满 = r.配额 !== null && r.已分 >= r.配额;
              return (
                <tr key={r.userId} data-testid={`org-lead-assign-${r.userId}`}>
                  <th scope="row"><span className="org-lead-assign-name" title={r.name}>{r.name}</span></th>
                  <td>{r.line ?? "两边都做"}</td>
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span>{r.已分} /</span>
                      {r.能设配额 ? (
                        <InputNumber size="small" min={0} max={10000} precision={0} placeholder="没填" style={{ width: 84 }}
                          aria-label={`${r.name} 的每月配额`} disabled={忙 === r.userId || 刷新中}
                          value={r.userId in 草稿 ? 草稿[r.userId] : r.配额}
                          onChange={(v) => set草稿((d) => ({ ...d, [r.userId]: typeof v === "number" ? v : null }))}
                          onBlur={() => 存配额(r)} onPressEnter={() => 存配额(r)} />
                      ) : (
                        <span>{r.配额 ?? "没填"}</span>
                      )}
                      {满 && <Tag color="warning" style={{ marginInlineEnd: 0 }}>满额</Tag>}
                    </span>
                  </td>
                  <td>{r.持有}</td>
                  <td>
                    <Switch size="small" checked={r.userId in 拨了 ? 拨了[r.userId] : r.参与} disabled={!r.能改参与 || 忙 !== null || 刷新中}
                      aria-label={`${r.name} 参与自动分配`} data-testid={`org-lead-auto-${r.userId}`}
                      onChange={(v) => {
                        set拨了((x) => ({ ...x, [r.userId]: v }));
                        void 跑(r.userId, () => 设自动分配参与(r.userId, v), v ? `${r.name} 恢复参与自动分配` : `${r.name} 暂停参与自动分配`);
                      }} />
                    {r.参与 && r.配额 === null && (
                      <span className="muted" style={{ marginInlineStart: 8 }} data-testid={`org-lead-noquota-${r.userId}`}>没填配额，不参与自动分配</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
