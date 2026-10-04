"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Dropdown, Space } from "antd";
import { UnorderedListOutlined, PlusOutlined } from "@ant-design/icons";
import { PageHead } from "@/components/ui";
import EmptyState from "@/components/EmptyState";
import { OPP_STAGES, OPP_STAGE_COLOR } from "@/lib/constants";
import { 金额, 按币种合计, 合计文字 } from "@/lib/currency";
import { useBusiness } from "@/lib/business-client";
import { stageLabel } from "@/lib/business-config";
import { moveStage } from "../actions";
import OpportunityForm from "../OpportunityForm";
import ContractForm from "../../customers/[id]/ContractForm";
import type { 可选成员 } from "@/lib/utils";

type Row = {
  id: string;
  name: string;
  amount: number;
  currency: string;
  stage: string;
  /** OPEN，或近几天赢下的 WON（赢单列，2026-10-04 J-090） */
  status: string;
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
export default function PipelineView({
  rows,
  赢单天数,
  users,
  customers,
}: {
  rows: Row[];
  /** 赢单列摆近几天赢下的（page.tsx 定） */
  赢单天数: number;
  /** 新建框要的两份候选（和列表页同一个框，见 ../OpportunityForm.tsx） */
  users: 可选成员[];
  customers: { id: string; name: string }[];
}) {
  const router = useRouter();
  const { message } = App.useApp();
  const b = useBusiness();
  /*
    「新建商机」就地弹框（2026-09-29）：原来这一页没有表单，点了跳回列表页再打开——按钮写着新建，人却被带走了。
    保存后留在管道里，新的那张卡亮两秒（和列表里新建的行同一种亮法），人一眼看见它落在哪一列
  */
  const [新建开着, set新建开着] = useState(false);
  const 见过 = useRef<Set<string> | null>(null);
  const [新来的, set新来的] = useState<string | null>(null);
  useEffect(() => {
    const ids = rows.map((r) => r.id);
    if (见过.current === null) {
      见过.current = new Set(ids);
      return;
    }
    const 新 = ids.filter((id) => !见过.current!.has(id));
    ids.forEach((id) => 见过.current!.add(id));
    if (新.length !== 1) return;
    set新来的(新[0]);
    const t = setTimeout(() => set新来的(null), 2000);
    return () => clearTimeout(t);
  }, [rows]);
  const 新建框 = (
    <OpportunityForm
      open={新建开着}
      editing={null}
      users={users}
      customers={customers}
      onClose={() => set新建开着(false)}
      onSaved={() => {
        set新建开着(false);
        router.refresh();
      }}
    />
  );
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  /**
   * 右边还有没露出来的列（审查 M3）：13 寸窗口下五列只露到第四列半，原来一点提示都没有。
   * 能往右滚且没滚到底时，右沿一道渐隐（.pipe-wrap[data-more]）；滚到底收起。
   */
  const 滚框 = useRef<HTMLDivElement>(null);
  const [还有, set还有] = useState(false);
  useEffect(() => {
    const el = 滚框.current;
    if (!el) return;
    const 量 = () => set还有(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    量();
    el.addEventListener("scroll", 量, { passive: true });
    const ro = new ResizeObserver(量);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", 量);
      ro.disconnect();
    };
  }, [rows.length]);

  /*
    拖进「赢单成交」先问登记签约（2026-10-04 J-090）。原来直接 moveStage：卡片消失（管道只取进行中的）、签约漏记，
    数据页业绩少算。现在弹「登记签约」（客户页同一个框，金额带商机金额）：
      保存 → 走 saveContract 的联动赢下这一单（签约和赢单连着记，删签约时能退回去，L-007）
      取消 → 照样赢单（人已经把它拖进去了），给一次撤销
    框开着的时候卡片先摆进赢单列（挪），不让人以为拖丢了；写完、新的 rows 回来之前也一直摆着，不闪回原列
  */
  const [签约框, set签约框] = useState<Row | null>(null);
  const [挪, set挪] = useState<{ id: string; stage: string; 前: Row[] } | null>(null);
  const 显示阶段 = (r: Row) => (挪 && 挪.id === r.id && (签约框?.id === r.id || 挪.前 === rows) ? 挪.stage : r.stage);

  async function 推进(r: Row, 到: string, 是撤销 = false) {
    if (r.stage === 到) return;
    if (到 === "赢单成交" && !是撤销) {
      set挪({ id: r.id, stage: 到, 前: rows });
      set签约框(r);
      return;
    }
    await 写阶段(r, 到, 是撤销);
  }

  async function 签约框关了(saved: boolean) {
    const r = 签约框;
    set签约框(null);
    if (!r) return;
    if (saved) return void router.refresh();
    await 写阶段(r, "赢单成交");
  }

  async function 写阶段(r: Row, 到: string, 是撤销 = false) {
    // 撤销时带回原来的概率（排查 D6）：r 是拖之前那一行，手填的 75% 不能变成阶段默认值
    const res = await moveStage(r.id, 到, 是撤销 ? r.probability : undefined);
    if (!res.ok) {
      set挪(null);
      message.error(res.error);
      router.refresh();
      return;
    }
    router.refresh();
    if (是撤销) return void message.success(`「${r.name}」已退回 ${stageLabel(b, 到)}`);
    // 手滑是拖拽最常见的结果，而这一下真写库了。给一条退路，并写清退到哪儿
    message.success({
      content: (
        <span>
          「{r.name}」已推进到 {stageLabel(b, 到)}
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
        <PageHead title="商机管道" subtitle="拖动卡片推进阶段" />
        <div className="card-soft">
          <EmptyState
            title="还没有商机"
            hint="管道是把在谈的单子按阶段摆开看：哪些卡在方案报价、哪一阶段压着最多钱。"
            primary={{ label: "新建第一条商机", onClick: () => set新建开着(true) }}
            demo={false}
          />
        </div>
        {新建框}
      </>
    );
  }

  return (
    <>
      <PageHead
        title="商机管道"
        subtitle="拖动卡片推进阶段"
        extra={
          <Space>
            <Button icon={<UnorderedListOutlined />} onClick={() => router.push("/opportunities")}>
              列表
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => set新建开着(true)}>
              新建商机
            </Button>
          </Space>
        }
      />

      <div className="pipe-wrap" data-more={还有 ? "" : undefined}>
      <div className="pipe" ref={滚框}>
        {OPP_STAGES.map((stage) => {
          const items = rows.filter((r) => 显示阶段(r) === stage);
          // 按币种分开加，不换汇（lib/currency.ts）：一列里有美元有欧元就写两段
          const sum = 合计文字(按币种合计(items, (r) => r.amount, (r) => r.currency), b.currency);
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
              <div className="pipe-h" title={stage === "赢单成交" ? `近 ${赢单天数} 天赢下的` : undefined}>
                <span className="pipe-dot" style={{ background: color }} />
                <b>{stageLabel(b, stage)}</b>
                <span className="pipe-n">{items.length}</span>
                <span className="pipe-sum" title={sum}>{sum}</span>
              </div>
              <div className="pipe-bar" style={{ background: color }} />

              {items.length === 0 && <div className="pipe-empty">{stage === "赢单成交" ? `近 ${赢单天数} 天还没有赢单` : "这一阶段没有在谈的"}</div>}

              {items.map((r) => (
                <Dropdown
                  key={r.id}
                  trigger={["contextMenu"]}
                  menu={{
                    items: [
                      ...OPP_STAGES.filter((s) => s !== r.stage).map((s) => ({ key: s, label: `推进到 ${stageLabel(b, s)}`, onClick: () => void 推进(r, s) })),
                      { type: "divider" as const },
                      { key: "open", label: `打开 ${r.customerName} 的记录`, onClick: () => router.push(`/customers/${r.customerId}`) },
                    ],
                  }}
                >
                  <div
                    className={`pipe-card${dragId === r.id ? " pipe-card-drag" : ""}${新来的 === r.id ? " pipe-card-fresh" : ""}`}
                    style={{ borderLeftColor: color }}
                    draggable
                    tabIndex={0}
                    role="button"
                    title={`${r.customerName} · ${r.probability}% · 右键或按 Enter 换一个阶段`}
                    aria-label={`${r.name}，${金额(r.amount, r.currency)}，${stageLabel(b, 显示阶段(r))}`}
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
                      <span className="pipe-card-a">{金额(r.amount, r.currency)}</span>
                      <span className="pipe-card-o">{r.ownerName}</span>
                    </div>
                  </div>
                </Dropdown>
              ))}
            </div>
          );
        })}
      </div>
      </div>
      {新建框}
      <ContractForm
        open={!!签约框}
        customerId={签约框?.customerId ?? ""}
        editing={null}
        赢这一单={签约框 ? { id: 签约框.id, name: 签约框.name, amount: 签约框.amount, currency: 签约框.currency } : null}
        onClose={(saved) => void 签约框关了(saved)}
      />
    </>
  );
}
