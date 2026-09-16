"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Dropdown } from "antd";
import { UnorderedListOutlined } from "@ant-design/icons";
import { PageHead } from "@/components/ui";
import EmptyState from "@/components/EmptyState";
import { OPP_STAGES, OPP_STAGE_COLOR } from "@/lib/constants";
import { money } from "@/lib/utils";
import { moveStage } from "../actions";

type Row = {
  id: string;
  name: string;
  amount: number;
  stage: string;
  probability: number;
  expectedDealAt: string | null;
  customerId: string;
  customerName: string;
  ownerName: string;
};

/**
 * 商机管道：按阶段分列，拖着推进。
 *
 * 三条和上一版不同：
 *   卡上只留名称、金额、负责人。原来还有客户、概率、预计成交——六行字挤在 272 宽里，
 *   一屏看不了几张，而拖动时真正要判断的就是「这是哪一单、多少钱、谁在跟」。
 *   客户名在卡片的悬停提示里，点一下就进他的记录页。
 *
 *   列头把这一列的**金额合计**摆出来。管道是拿来看钱怎么分布的，
 *   只数张数看不出「谈判阶段压着两百万」。
 *
 *   推进之后给一次撤销。拖拽最容易手滑，而这一下是真写库的；
 *   没有撤销，人就只能再拖回去——而且未必记得原来在哪一列。
 */
export default function PipelineView({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);

  async function 推进(r: Row, 到: string, 是撤销 = false) {
    if (r.stage === 到) return;
    const res = await moveStage(r.id, 到);
    if (!res.ok) {
      message.error(res.error);
      router.refresh();
      return;
    }
    router.refresh();
    if (是撤销) return void message.success(`「${r.name}」已退回 ${到}`);
    // 手滑是拖拽最常见的结果，而这一下真写库了。给一条退路，并写清退到哪儿
    message.success({
      content: (
        <span>
          「{r.name}」已推进到 {到}
          <Button type="link" size="small" onClick={() => 推进({ ...r, stage: 到 }, r.stage, true)}>
            撤销
          </Button>
        </span>
      ),
      duration: 6,
    });
  }

  function drop(stage: string) {
    setOverStage(null);
    const row = rows.find((r) => r.id === dragId);
    setDragId(null);
    if (row) void 推进(row, stage);
  }

  if (rows.length === 0) {
    return (
      <>
        <PageHead title="商机管道" subtitle="按阶段看在谈的单子" />
        <div className="card-soft">
          <EmptyState
            title="还没有商机"
            hint="管道是把在谈的单子按阶段摆开看：哪些卡在方案报价、哪一阶段压着最多钱。先去商机列表建一条。"
            primary={{ label: "去商机列表", onClick: () => router.push("/opportunities") }}
            demo={false}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="商机管道"
        subtitle="拖动卡片推进阶段；键盘用 Enter 打开卡片菜单"
        extra={
          <Button icon={<UnorderedListOutlined />} onClick={() => router.push("/opportunities")}>
            列表视图
          </Button>
        }
      />

      <div className="pipe">
        {OPP_STAGES.map((stage) => {
          const items = rows.filter((r) => r.stage === stage);
          const sum = items.reduce((s, r) => s + r.amount, 0);
          const color = OPP_STAGE_COLOR[stage];
          const active = overStage === stage;

          return (
            <div
              key={stage}
              className={`pipe-col${active ? " pipe-col-on" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOverStage(stage);
              }}
              onDragLeave={() => setOverStage((s) => (s === stage ? null : s))}
              onDrop={() => drop(stage)}
            >
              <div className="pipe-h">
                <span className="pipe-dot" style={{ background: color }} />
                <b>{stage}</b>
                <span className="pipe-n">{items.length}</span>
                <span className="pipe-sum">{money(sum)}</span>
              </div>
              <div className="pipe-bar" style={{ background: color }} />

              {items.length === 0 && <div className="pipe-empty">这一阶段没有在谈的</div>}

              {items.map((r) => (
                <Dropdown
                  key={r.id}
                  trigger={["contextMenu"]}
                  menu={{
                    items: [
                      ...OPP_STAGES.filter((s) => s !== r.stage).map((s) => ({ key: s, label: `推进到 ${s}`, onClick: () => void 推进(r, s) })),
                      { type: "divider" as const },
                      { key: "open", label: `打开 ${r.customerName} 的记录`, onClick: () => router.push(`/customers/${r.customerId}`) },
                    ],
                  }}
                >
                  <div
                    className={`pipe-card${dragId === r.id ? " pipe-card-drag" : ""}`}
                    style={{ borderLeftColor: color }}
                    draggable
                    tabIndex={0}
                    role="button"
                    title={`${r.customerName} · ${r.probability}% · 右键或按 Enter 换一个阶段`}
                    aria-label={`${r.name}，${money(r.amount)}，${r.stage}`}
                    onDragStart={() => setDragId(r.id)}
                    onDragEnd={() => setDragId(null)}
                    onClick={() => router.push(`/customers/${r.customerId}`)}
                    onKeyDown={(e) => {
                      // 键盘也要能换阶段：拖拽是鼠标专属的，只有它就等于键盘用不了这一页
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: e.currentTarget.getBoundingClientRect().left + 20, clientY: e.currentTarget.getBoundingClientRect().top + 20 }));
                      }
                    }}
                  >
                    <div className="pipe-card-t">{r.name}</div>
                    <div className="pipe-card-m">
                      <span className="pipe-card-a">{money(r.amount)}</span>
                      <span className="pipe-card-o">{r.ownerName}</span>
                    </div>
                  </div>
                </Dropdown>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}
