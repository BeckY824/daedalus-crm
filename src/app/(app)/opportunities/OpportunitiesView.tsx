"use client";

import { 供应商页 } from "@/lib/features";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Space, Select, Tag, InputNumber, DatePicker, App, Dropdown, Popover } from "antd";
import {
  PlusOutlined,
  MoreOutlined,
  DeleteOutlined,
  EditOutlined,
  PartitionOutlined,
} from "@ant-design/icons";
import ResetFilters from "@/components/ResetFilters";
import { 列表不问归属 } from "@/lib/solo";
import ListSearch from "@/components/ListSearch";
import { PageHead, CustomerLink, UserCell } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
import { OPP_STAGES, STAGE_PROBABILITY } from "@/lib/constants";
import { fmtDate, dayjs, 成员选项, 可选成员 } from "@/lib/utils";
import { deleteOpportunities, restoreOpportunities, 删商机前清点, moveStage, setOppStatus } from "./actions";
import { saveContract } from "../customers/actions";
import ContractForm from "../customers/[id]/ContractForm";
import InlineConfirm from "@/components/InlineConfirm";
import OpportunityForm from "./OpportunityForm";
import CompareDrawer from "./CompareDrawer";
import { 金额格式 } from "@/lib/money-input";
import { 金额, 合计文字, 币种符号 } from "@/lib/currency";
import { useBusiness } from "@/lib/business-client";
import { stageLabel, 外贸订单, 外贸精简 } from "@/lib/business-config";
import { useUrlFilters } from "@/lib/url-filters";

type 币种合计 = { 币种: string; 合计: number };

export type OppRow = {
  id: string;
  name: string;
  amount: number;
  /** 币种（2026-10-03） */
  currency: string;
  stage: string;
  status: string;
  probability: number;
  expectedDealAt: string | null;
  /** 外贸模版下叫「询盘时间」（2026-10-05）：商机是哪天来的，人能改 */
  createdAt: string;
  remark: string | null;
  customerId: string;
  customerName: string;
  ownerId: string;
  ownerName: string;
  /** 编辑框的版本号：保存时带回去，期间有人改过就不盖掉（排查 D3，lib/edit-version.ts） */
  updatedAt: string;
};

export default function OpportunitiesView({
  汇总,
  rows,
  总数,
  users,
  customers,
  filters,
}: {
  rows: OppRow[];
  /** 库里一共多少条。行只取了前 300，分页条不能拿行数冒充总数 */
  总数: number;
  /** 汇总药丸的两个数，服务端按全量算好（行只取了前 300，拿行去加会少） */
  汇总: { 单数: number; 合计: 币种合计[]; 预测: 币种合计[] };
  users: 可选成员[];
  customers: { id: string; name: string }[];
  filters: { keyword: string; stage: string; status: string; ownerId: string };
}) {
  const router = useRouter();
  const b = useBusiness();
  /** 正在看哪个商机的供应商比价（外贸模版，3c） */
  const [比价, set比价] = useState<OppRow | null>(null);
  const 比价项 = (r: OppRow) => (b.template === "trade" && 供应商页 ? [{ key: "compare", label: "供应商比价", onClick: () => set比价(r) }] : []);
  /*
    外贸模版（2026-10-05 外贸客户建议）：赢单叫「转为订单」——和线索转客户一个意思，点了就是订单框（金额币种从商机带），
    存下来是一张订单 + 一笔签约、这个商机标为已转订单（lib/order-contract.ts）。不摆成交概率、预计成交，改摆询盘时间
  */
  const 是订单 = 外贸订单(b);
  const 外贸 = 外贸精简(b);
  const 赢了叫 = 是订单 ? "已转订单" : "已赢单";
  /** 正在把哪个商机转为订单 */
  const [转订单, set转订单] = useState<OppRow | null>(null);
  /** 「赢单」那一下：外贸直接开订单框，其它模版就地问要不要顺手登记签约 */
  const 去赢 = (r: OppRow) => {
    set问丢单(null);
    if (是订单) set转订单(r);
    else set问赢单(r.id);
  };
  const { message, modal } = App.useApp();
  const { f, setF, apply, reset, pending } = useUrlFilters("/opportunities", filters);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<OppRow | null>(null);

  /** 哪一行正在问「标为丢单？」/「标为赢单」。从「更多」菜单里点进来，就地问，不弹框 */
  const [问丢单, set问丢单] = useState<string | null>(null);
  const [问赢单, set问赢单] = useState<string | null>(null);

  /** 状态刚变的那一行亮两秒（DataList 的 亮）。先清一帧再点亮：同一行两秒内再变一次（丢单后马上撤销），动画要重播 */
  const [亮行, set亮行] = useState<string[]>([]);
  const 亮计时 = useRef<ReturnType<typeof setTimeout> | null>(null);
  function 亮一下(id: string) {
    if (亮计时.current) clearTimeout(亮计时.current);
    set亮行([]);
    requestAnimationFrame(() => set亮行([id]));
    亮计时.current = setTimeout(() => set亮行([]), 2000);
  }

  /**
   * 标丢单：就地确认之后才写，写完给一次撤销（2026-09-28 审查 S7）。
   * 撤销走 setOppStatus 改回进行中，**阶段和概率原样带回去**——丢单会把概率清零，
   * 只改 status 的话人手填的 75% 就没了。
   */
  async function 标丢单(r: OppRow) {
    const res = await setOppStatus(r.id, "LOST");
    if (!res.ok) return void message.error(res.error);
    router.refresh();
    亮一下(r.id);
    const key = `lost-${r.id}`;
    message.success({
      key,
      content: (
        <span>
          「{r.name}」已标为丢单
          <Button
            type="link"
            size="small"
            onClick={async () => {
              message.destroy(key);
              const back = await setOppStatus(r.id, "OPEN", { stage: r.stage, probability: r.probability });
              if (!back.ok) return void message.error(back.error);
              message.success(`「${r.name}」已改回进行中`);
              router.refresh();
              亮一下(r.id);
            }}
          >
            撤销
          </Button>
        </span>
      ),
      duration: 6,
    });
  }

  /**
   * 标赢单，顺手问一句要不要登记签约（2026-09-28 审查 S3）。
   * 原来这两条线互不相通：赢了单，本月签约金额和客户状态都不动。
   * 选登记就走 saveContract——查重、留痕、把客户推到「已签约」都在那里面，这里不另写一遍。
   */
  async function 标赢单(r: OppRow, 签约: { amount: number; signedAt: Date } | null) {
    /*
      登记签约时让 saveContract 的联动去赢这一单（2026-10-04 L-007）：签约和赢单连着记，之后删掉这笔签约，商机能退回去。
      原来先 setOppStatus 再单独登记，两者之间什么都不留，删了签约商机还挂赢单、业绩虚高。
      没登记上（查重拦下、出错）或者没要签约：照旧直接标赢单——人点的就是「赢单」
    */
    let 已赢 = false;
    let 另 = "";
    if (签约) {
      const c = await saveContract({
        customerId: r.customerId, amount: 签约.amount, currency: r.currency, signedAt: 签约.signedAt, remark: `商机「${r.name}」赢单时登记`,
        联动: { 赢单: [r.id], 完成计划: [], 完成待办: [] },
      });
      if (c.ok) {
        另 = `，签约 ${金额(签约.amount, r.currency)} 已登记`;
        已赢 = (c.联动?.赢单 ?? 0) > 0;
      } else if ("duplicate" in c) {
        message.warning(`${r.customerName} 在 ${fmtDate(c.duplicate.signedAt)} 已有一笔 ${金额(c.duplicate.amount, c.duplicate.currency)} 的签约，没有重复登记`);
      } else message.error(c.error);
    }
    if (!已赢) {
      const res = await setOppStatus(r.id, "WON");
      if (!res.ok) return void message.error(res.error);
    }
    set问赢单(null);
    message.success(`恭喜赢单${另}`);
    router.refresh();
    亮一下(r.id);
  }

  /**
   * 汇总药丸（审查 M12）：没按状态筛时只算**进行中**的——原来「总额」把已丢单、已赢单也加进去，
   * 旁边的「加权预测」却只算进行中的，两个数摆在一起口径不一样。想看赢了多少、丢了多少，用「状态」筛；
   * 筛了状态就是那一类的合计。口径写在药丸上，不藏在悬停提示里。
   */
  const 筛的状态 = filters.status;
  const { 合计, 预测: forecast } = 汇总;
  const 合计叫 = 筛的状态 === "WON" ? "已赢单" : 筛的状态 === "LOST" ? "已丢单" : "进行中";
  /** 只有一个人：负责人列、「全部成员」筛选都不摆（审查 D2），见 lib/solo.ts */
  const 不问归属 = !f.ownerId && 列表不问归属(users, rows.map((r) => r.ownerName));

  /**
   * 列表里改阶段，和看板拖卡片一样给一次撤销（审查 M11）。
   * 撤销就是改回原阶段；概率由 moveStage 按「人没改过才跟着变」的规矩处理，手填的 75% 不会被冲掉
   */
  async function 改阶段(r: OppRow, 到: string, 是撤销 = false) {
    // 撤销时把原来的概率带回去（排查 D6）：r 是推进之前那一行，r.probability 就是人原来填的
    const res = await moveStage(r.id, 到, 是撤销 ? r.probability : undefined);
    if (!res.ok) {
      message.error(res.error);
      router.refresh();
      return;
    }
    router.refresh();
    亮一下(r.id);
    const key = `stage-${r.id}`;
    if (是撤销) return void message.success({ key, content: `「${r.name}」已退回 ${stageLabel(b, 到)}` });
    message.success({
      key,
      duration: 6,
      content: (
        <span>
          「{r.name}」已推进到 {stageLabel(b, 到)}
          <Button type="link" size="small" onClick={() => { message.destroy(key); void 改阶段({ ...r, stage: 到 }, r.stage, true); }}>
            撤销
          </Button>
        </span>
      ),
    });
  }

  /**
   * 删商机（排查 D2）：先说清关联着几条跟进（删了那几条不再写是哪个商机）、是不是赢单的；删完给一次撤销。
   * 原来只问一句标题，删了就没了
   */
  async function 问删商机(r: OppRow) {
    const 数 = await 删商机前清点([r.id]).catch(() => null);
    const 话 = [
      数?.跟进 ? `有 ${数.跟进} 条跟进记录关联着它，删了之后那几条不再写是哪个商机` : "",
      数?.赢单 ? "这是一个已经赢单的商机，数据页的赢单数会跟着少" : "",
    ].filter(Boolean);
    modal.confirm({
      title: `删除商机「${r.name}」？`,
      content: 话.length ? <div style={{ lineHeight: 1.7 }}>{话.map((x) => <div key={x}>{x}。</div>)}</div> : undefined,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        const res = await deleteOpportunities([r.id]);
        router.refresh();
        if (!res.ok) return void message.error(res.error);
        const key = `opp-del-${r.id}`;
        message.success({
          key,
          duration: 6,
          content: (
            <span>
              已删除「{r.name}」
              <Button
                type="link"
                size="small"
                onClick={async () => {
                  message.destroy(key);
                  if (!res.ok) return;
                  const u = await restoreOpportunities(res.快照);
                  if (!u.ok) return void message.error(u.error);
                  if (!u.回来) return void message.error("没能撤回来：这位客户可能已经不在了");
                  message.success(`「${r.name}」回来了`);
                  router.refresh();
                }}
              >
                撤销
              </Button>
            </span>
          ),
        });
      },
    });
  }

  /** 已关闭的商机重新打开（审查 D13）。原来只能进编辑表单改状态 */
  async function 重开(r: OppRow) {
    // 赢单时阶段被推到了「赢单成交」，重开退回上一步「谈判审核」；丢单的阶段原样留着
    const 阶段 = r.stage === "赢单成交" ? "谈判审核" : r.stage;
    const res = await setOppStatus(r.id, "OPEN", { stage: 阶段, probability: STAGE_PROBABILITY[阶段] ?? 20 });
    if (!res.ok) return void message.error(res.error);
    message.success(`「${r.name}」已重新打开，回到 ${阶段}`);
    router.refresh();
    亮一下(r.id);
  }

  const 列表: 列<OppRow>[] = [
    {
      // 名字悬停变链接色，点了却没反应（J-093）。商机没有自己的详情页，点名字就打开这一单的编辑框——
      // 和客户列表点名字进记录页一个意思：点名字 = 看这一条
      title: "商机", key: "name", dataIndex: "name", width: 200, 常驻: true,
      render: (v, r) => (
        <button type="button" className="link-strong link-plain" onClick={() => { setEditing(r); setOpen(true); }}>
          {v}
        </button>
      ),
    },
    {
      title: `所属${b.customer}`, 列名: `所属${b.customer}`, key: "customerName", dataIndex: "customerName", width: 170,
      render: (v, r) => <CustomerLink id={r.customerId} name={v} />,
    },
    {
      title: "金额", key: "amount", dataIndex: "amount", width: 110,
      sorter: (a, b2) => a.amount - b2.amount,
      render: (v, r) => <span style={{ fontWeight: 600 }}>{金额(v, r.currency)}</span>,
    },
    {
      title: "阶段", key: "stage", dataIndex: "stage", width: 140,
      render: (v, r) =>
        // 已关闭的不再摆一个灰掉的下拉（看着像空占位符，审查 D13），直接写结果
        r.status !== "OPEN" ? (
          <Tag color={r.status === "WON" ? "success" : "error"} style={{ margin: "0 0 0 11px", borderRadius: 6 }}>
            {r.status === "WON" ? 赢了叫 : "已丢单"}
          </Tag>
        ) : (
          <Select
            size="small"
            value={v}
            variant="borderless"
            style={{ width: 128 }}
            options={OPP_STAGES.map((s2) => ({ value: s2, label: stageLabel(b, s2) }))}
            // 选「赢单成交」先问要不要顺手登记签约（2026-10-04 J-090），和「更多 → 标记赢单」同一个问话；不问就改，签约会漏记
            onChange={(s2) => (s2 === "赢单成交" ? 去赢(r) : void 改阶段(r, s2))}
          />
        ),
    },
    // 外贸不摆概率（客户：「没有意义」）——小团队不估这个数，阶段已经说明谈到哪了
    ...(外贸 ? [] : [{ title: "概率", key: "probability", dataIndex: "probability", width: 76, render: (v: number) => `${v}%` }]),
    ...(不问归属 ? [] : [{ title: "负责人", key: "ownerName", dataIndex: "ownerName", width: 120, render: (v: string) => <UserCell name={v} size={24} /> }]),

    /*
      外贸：「预计成交」换成「询盘时间」（客户：同一个需求 3 月问了一次没成、5 月又问一次，这样知道客户计划采购的时间点）。
      询盘时间是发生过的事，预计成交是猜的
    */
    外贸
      ? { title: "询盘时间", key: "createdAt", dataIndex: "createdAt", width: 116, sorter: (a, b2) => a.createdAt.localeCompare(b2.createdAt), render: (v) => <span className="muted nowrap">{fmtDate(v)}</span> }
      : { title: "预计成交", key: "expectedDealAt", dataIndex: "expectedDealAt", width: 116, 默认: false, render: (v) => <span className="muted nowrap">{fmtDate(v)}</span> },
    {
      title: "状态", key: "status", dataIndex: "status", width: 106, 默认: false,
      render: (v) => (
        <Tag color={v === "WON" ? "success" : v === "LOST" ? "error" : "processing"} style={{ margin: 0, borderRadius: 6 }}>
          {v === "WON" ? 赢了叫 : v === "LOST" ? "已丢单" : "进行中"}
        </Tag>
      ),
    },
    {
      title: "", key: "act", width: 110, 常驻: true, fixed: "right",
      render: (_, r) => (
        // 问「标为丢单？」那一句比这一格宽：盖在左边一格上（.opp-act），不临时加宽——加宽整张表会跳一下
        <span className="opp-act">
        <InlineConfirm
          问="标为丢单？"
          是="丢单"
          开={问丢单 === r.id}
          set开={(v) => set问丢单(v ? r.id : null)}
          做={() => 标丢单(r)}
        >
        <Space size={2}>
          {/* 赢单 / 丢单 收进「更多」：一行里摆两个文字按钮太吵，六列也就挤不下了。
              它们是结果不是日常动作，一天点不了几次。
              两样都不再一点就生效：丢单就地问一句，赢单就地问要不要顺手登记签约 */}
          {r.status !== "OPEN" && (
            <Dropdown
              menu={{
                items: [
                  ...比价项(r),
                  { key: "reopen", label: "重新打开", onClick: () => void 重开(r) },
                ],
              }}
            >
              <Button aria-label={`${r.name} 的更多操作`} title="更多" type="text" size="small" icon={<MoreOutlined />} />
            </Dropdown>
          )}
          {r.status === "OPEN" && (
            <Popover
              open={问赢单 === r.id}
              trigger={[]}
              placement="bottomRight"
              destroyOnHidden
              content={<WonAsk r={r} 做={(签约) => 标赢单(r, 签约)} 取消={() => set问赢单(null)} />}
            >
              <Dropdown
                menu={{
                  items: [
                    ...比价项(r),
                    { key: "won", label: 是订单 ? "转为订单" : "标记赢单", onClick: () => 去赢(r) },
                    { key: "lost", label: "标记丢单", danger: true, onClick: () => { set问赢单(null); set问丢单(r.id); } },
                  ],
                }}
              >
                <Button aria-label={`${r.name} 的更多操作`} title="更多" type="text" size="small" icon={<MoreOutlined />} />
              </Dropdown>
            </Popover>
          )}
          <Button
            aria-label={`编辑 ${r.name}`}
            title="编辑"
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditing(r);
              setOpen(true);
            }}
          />
          <Button
            aria-label={`删除 ${r.name}`}
            title="删除"
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => void 问删商机(r)}
          />
        </Space>
        </InlineConfirm>
        </span>
      ),
    },
  ];

  return (
    <>
      {/* 列表和管道是同一批商机的两种视图，所以「管道」是页头上的次动作，
          不再为它常驻一列中栏（设计稿 03/LAYOUT：中栏不是默认栏位）。 */}
      <PageHead
        title="商机"
        subtitle="进行中与已关闭的商机"
        extra={
          <Space>
            <Button icon={<PartitionOutlined />} onClick={() => router.push("/opportunities/pipeline")}>
              管道
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              新建商机
            </Button>
          </Space>
        }
      />

      {/*
        原来这里是三张各占三分之一屏的统计卡。它们说的是同一件事的三个侧面，
        用不着三张卡、三条边框、三块留白——一行就够，而且紧挨着表格，
        看完数直接往下看是哪几单撑起来的。
        **一条商机都没有时整行不出现**：0 / 0 / 0 不是信息，是噪音。
      */}
      <DataList<OppRow>
        截断={{ 总数 }}
        页="opportunities"
        空库={rows.length === 0 && !Object.values(filters).some((v) => v)}
        列={列表}
        行={rows}
        亮={亮行}
        加载中={pending}
        空态={{
          title: "还没有商机",
          hint: 是订单
            ? `商机是一次询盘：问的什么、报了多少、谈到哪一步。它挂在${b.customer}下面，客户确认后点「转为订单」。`
            : `商机是「在谈的那一单」：金额多少、谈到哪一步、大概什么时候成。它挂在${b.customer}下面，签约之后再登记成签约记录。`,
          primary: { label: "新建第一条商机", onClick: () => { setEditing(null); setOpen(true); } },
        }}
        汇总={
          /* 一条药丸，摆在工具栏和表格之间（设计稿 15/PAGE）：
             筛完看到的就是这一筛的总额和预测，紧接着往下看是哪几单撑起来的。
             **一条商机都没有时不出现**：0 / 0 不是信息，是噪音 */
          rows.length > 0 ? (
            <div className="list-sum" title={外贸 ? undefined : "加权预测：Σ(进行中商机金额 × 成交概率)，概率是每条商机上自己填的"}>
              {合计叫 === "已赢单" ? 赢了叫 : 合计叫} {汇总.单数} 单 · {合计文字(合计, b.currency)}
              {合计叫 === "进行中" && !外贸 && <> · 加权预测 {合计文字(forecast.map((x) => ({ ...x, 合计: Math.round(x.合计) })), b.currency)}</>}
            </div>
          ) : null
        }
        筛选={
          <Space wrap size={[10, 10]}>
            <ListSearch
              width={240}
              placeholder={`商机名称 / ${b.customer}`}
              value={f.keyword}
              onChange={(v) => setF({ ...f, keyword: v })}
              onSearch={(v) => apply({ keyword: v })}
            />
            <Select
              style={{ width: 130 }}
              placeholder="全部阶段"
              allowClear
              value={f.stage || undefined}
              onChange={(v) => apply({ stage: v ?? "" })}
              options={OPP_STAGES.map((s2) => ({ value: s2, label: stageLabel(b, s2) }))}
            />
            <Select
              style={{ width: 120 }}
              placeholder="全部状态"
              allowClear
              value={f.status || undefined}
              onChange={(v) => apply({ status: v ?? "" })}
              options={[
                { value: "OPEN", label: "进行中" },
                { value: "WON", label: 赢了叫 },
                { value: "LOST", label: "已丢单" },
              ]}
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
            <ResetFilters 显示={Object.values(f).some(Boolean)} onClick={reset} />
          </Space>
        }
      />

      {供应商页 && <CompareDrawer open={比价 !== null} opp={比价} onClose={() => set比价(null)} />}
      {/* 外贸：转为订单 = 从这一单开订单框（和管道里拖进「客户确认」同一个框） */}
      {转订单 && (
        <ContractForm
          open
          customerId={转订单.customerId}
          editing={null}
          赢这一单={{ id: 转订单.id, name: 转订单.name, amount: 转订单.amount, currency: 转订单.currency }}
          onClose={(saved) => {
            const r = 转订单;
            set转订单(null);
            if (saved) {
              router.refresh();
              亮一下(r.id);
            }
          }}
        />
      )}
      <OpportunityForm
        open={open}
        editing={editing}
        users={users}
        customers={customers}
        onClose={() => setOpen(false)}
        onSaved={() => {
          setOpen(false);
          router.refresh();
        }}
      />
    </>
  );
}

/**
 * 「标记赢单」的就地确认：顺手登记签约吗。金额带商机金额、日期今天，都能改；也可以只标赢单。
 * 放在 Popover 里而不是弹框：它就是一句问话加两个可改的数，盖半屏不值得。
 */
function WonAsk({ r, 做, 取消 }: { r: OppRow; 做: (签约: { amount: number; signedAt: Date } | null) => Promise<void>; 取消: () => void }) {
  const [amount, setAmount] = useState<number | null>(r.amount > 0 ? r.amount : null);
  const [day, setDay] = useState(dayjs());
  const [忙, set忙] = useState<"签" | "只" | null>(null);
  const 跑 = async (哪个: "签" | "只") => {
    set忙(哪个);
    try {
      await 做(哪个 === "签" && amount ? { amount, signedAt: day.toDate() } : null);
    } finally {
      set忙(null);
    }
  };
  return (
    <div className="won-ask">
      <div className="won-ask-t">「{r.name}」标为赢单</div>
      <div className="won-ask-s">顺手给 {r.customerName} 登记一笔签约？</div>
      <Space size={8}>
        <InputNumber<number>
          aria-label="签约金额"
          prefix={币种符号(r.currency)}
          min={0}
          step={1000}
          style={{ width: 150 }}
          placeholder="签约金额"
          value={amount}
          onChange={(v) => setAmount(v)}
          formatter={金额格式}
        />
        <DatePicker aria-label="签约日期" allowClear={false} value={day} onChange={(d) => d && setDay(d)} style={{ width: 140 }} />
      </Space>
      <Space size={8} className="won-ask-b">
        <Button type="primary" size="small" loading={忙 === "签"} disabled={!amount || (忙 !== null && 忙 !== "签")} onClick={() => void 跑("签")}>
          赢单并登记签约
        </Button>
        <Button size="small" loading={忙 === "只"} disabled={忙 !== null && 忙 !== "只"} onClick={() => void 跑("只")}>
          只标赢单
        </Button>
        <Button size="small" type="text" onClick={取消}>取消</Button>
      </Space>
    </div>
  );
}
