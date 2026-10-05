"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Card, Col, DatePicker, Input, InputNumber, Row, Segmented, Select, Space } from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import CurrencySelect from "@/components/CurrencySelect";
import { 毛利 } from "@/lib/supplier";
import { PageHead } from "@/components/ui";
import { dayjs, fmtDate } from "@/lib/utils";
import { 金额 } from "@/lib/currency";
import { 金额格式 } from "@/lib/money-input";
import { 节点状态们, 单据状态们, 当前节点, 节点灯, 进度, 超期数, 订单的钱 } from "@/lib/order";
import { 小计, 报价合计 } from "@/lib/quote";
import type { 订单详情数据 } from "@/lib/order-db";
import { saveOrderPurchase, saveOrder, saveOrderNode, saveOrderDoc, addOrderDoc, deleteOrderDoc, addOrderNodeNote, deleteOrder } from "../actions";
import OrderForm from "../OrderForm";
import ContractForm from "../../customers/[id]/ContractForm";

/**
 * 一张订单（2026-10-03 外贸第 3a 块）。
 *
 * 顶上是 12 步：每一步只有「截止日 + 状态」，颜色说话（红 = 超期 / 卡住，黄 = 3 天内到期，绿 = 完成，灰 = 不适用）。
 * 点一步在下面展开：改截止日、改状态、在这一步记一笔（问工厂的结果、货代回的船期……都是一条跟进）。
 * 再往下是钱（定金 / 尾款的应收实收）和单据清单。默认打开「当前节点」——人进来就是想看卡在哪。
 */
type 供应商选项 = { id: string; name: string; rating: string | null }[];

export default function OrderView({ o, 供应商 = [], 先看 }: { o: 订单详情数据; 供应商?: 供应商选项; 先看?: number }) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const 当前 = 当前节点(o.nodes);
  const [选, set选] = useState<number>(先看 ?? 当前?.idx ?? 1);
  const [编辑, set编辑] = useState(false);
  const [改签约, set改签约] = useState(false);
  /** 挂在整单上、不挂某一步的记录（nodeIdx 0：跟进表单「关联商机 / 订单」选的、轻量订单页记的） */
  const 整单记录 = o.notes.filter((x) => x.nodeIdx === 0);
  const 节 = o.nodes.find((n) => n.idx === 选) ?? o.nodes[0];

  async function 跑<T extends { ok: boolean }>(p: Promise<T>, 成?: string) {
    const r = await p;
    if (!r.ok) {
      message.error((r as unknown as { error: string }).error);
      return false;
    }
    if (成) message.success(成);
    router.refresh();
    return true;
  }

  function 删除() {
    modal.confirm({
      title: `删除订单 ${o.no}？`,
      content: "12 个节点、单据清单、定金尾款的记录会一起删掉，不能撤销。在节点上记过的跟进留在客户的时间线里，不会删。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        const r = await deleteOrder(o.id);
        if (!r.ok) return message.error(r.error);
        message.success("订单已删除");
        router.push("/orders");
      },
    });
  }

  const 钱 = 订单的钱(o);
  const 超 = 超期数(o.nodes);

  return (
    <>
      <PageHead
        title={`订单 ${o.no}`}
        subtitle={[o.customer.name, 金额(o.amount, o.currency), o.incoterm, o.payment, `业务员 ${o.ownerName}`].filter(Boolean).join(" · ")}
        extra={
          <Space>
            {/*
              有签约的订单（外贸「订单 = 签约」，2026-10-05）：订单号、金额币种、确认时间、付款方式、供应商在订单框里和签约一起改；
              这边的「条款 · 定金」只改贸易条款和定金应收。删在客户页（删的是那笔签约，跟进状态要不要退回在那里问）
            */}
            {o.contract && <Button icon={<EditOutlined />} onClick={() => set改签约(true)}>编辑</Button>}
            <Button icon={o.contract ? undefined : <EditOutlined />} onClick={() => set编辑(true)}>{o.contract ? "条款 · 定金" : "编辑"}</Button>
            {!o.contract && <Button danger icon={<DeleteOutlined />} onClick={删除} aria-label="删除订单" />}
          </Space>
        }
      />

      <div className="ord-sum">
        <span>{当前 ? <>当前 <b>{当前.idx}. {当前.name}</b></> : <b>12 步都走完了</b>}</span>
        <span>进度 <b>{进度(o.nodes)}%</b></span>
        {超 > 0 && <span className="ord-late">超期 {超} 步</span>}
        <span>未收 <b>{钱.未收 > 0 ? 金额(钱.未收, o.currency) : "收齐了"}</b></span>
        <Link href={`/customers/${o.customer.id}`}>{o.customer.name} 的记录 ›</Link>
        {o.opportunity && <Link href={`/opportunities?keyword=${encodeURIComponent(o.opportunity.name)}`}>来自商机「{o.opportunity.name}」 ›</Link>}
      </div>

      <ol className="ord-steps" aria-label="订单节点">
        {o.nodes.map((n) => {
          const 色 = 节点灯(n);
          return (
            <li key={n.idx}>
              <button
                type="button"
                className={`ord-step ord-step-${色}${n.idx === 选 ? " on" : ""}${当前?.idx === n.idx ? " now" : ""}`}
                onClick={() => set选(n.idx)}
                aria-pressed={n.idx === 选}
                aria-label={`第 ${n.idx} 步 ${n.name}：${n.status}${n.dueAt ? `，截止 ${fmtDate(n.dueAt)}` : ""}`}
              >
                <span className="ord-step-i">{n.idx}</span>
                <span className="ord-step-n">{n.name}</span>
                <span className="ord-step-s">{n.status === "已完成" || n.status === "不适用" ? n.status : n.dueAt ? `截止 ${fmtDate(n.dueAt)}` : n.status}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <Card className="ord-node" title={<span className="section-title">第 {节.idx} 步 · {节.name}</span>}>
        <NodePanel key={节.idx} o={o} 节={节} 跑={跑} />
      </Card>

      {整单记录.length > 0 && (
        <Card style={{ marginTop: 16 }} title={<span className="section-title">整单的记录 {整单记录.length}</span>}>
          <ul className="ord-notes">
            {整单记录.map((x) => (
              <li key={x.id}>
                <span className="ord-notes-t">{fmtDate(x.occurredAt)} · {x.who}</span>
                <span className="ord-notes-c">{x.content}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={12}>
          <Card title={<span className="section-title">钱</span>}>
            <MoneyPanel key={`${o.depositPaid}-${o.balancePaid}-${o.depositAt}-${o.balanceAt}`} o={o} 尾款应收={钱.尾款应收} 跑={跑} />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title={<span className="section-title">单据</span>} extra={<span className="muted">{o.docs.filter((d) => d.state === "已收" || d.state === "已发客户" || d.state === "不需要").length} / {o.docs.length} 齐</span>}>
            <DocsPanel o={o} 跑={跑} />
          </Card>
        </Col>
        <Col span={24}>
          <Card title={<span className="section-title">采购与毛利</span>}>
            <PurchasePanel key={JSON.stringify(o.采购)} o={o} 供应商={供应商} 跑={跑} />
          </Card>
        </Col>
        {o.报价 && (
          <Col span={24}>
            <Card title={<span className="section-title">报价明细</span>} extra={<span className="muted">{fmtDate(o.报价.quotedAt)} 报的价，来自商机</span>}>
              <table className="ord-quote">
                <thead><tr><th>产品</th><th>规格</th><th className="r">数量</th><th className="r">单价</th><th className="r">小计</th></tr></thead>
                <tbody>
                  {o.报价.行.map((r, i) => (
                    <tr key={i}><td>{r.product}</td><td>{r.spec ?? ""}</td><td className="r">{r.qty}{r.unit ? ` ${r.unit}` : ""}</td><td className="r">{金额(r.unitPrice, o.报价!.currency)}</td><td className="r">{金额(小计(r), o.报价!.currency)}</td></tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={4}>合计</td><td className="r"><b>{金额(报价合计(o.报价.行), o.报价.currency)}</b></td></tr></tfoot>
              </table>
            </Card>
          </Col>
        )}
        {o.remark && (
          <Col span={24}>
            <Card title={<span className="section-title">备注</span>}><div style={{ whiteSpace: "pre-wrap" }}>{o.remark}</div></Card>
          </Col>
        )}
      </Row>

      <OrderForm
        open={编辑}
        editing={{ id: o.id, no: o.no, amount: o.amount, currency: o.currency, incoterm: o.incoterm, payment: o.payment, depositDue: o.depositDue, remark: o.remark }}
        跟签约={!!o.contract}
        onClose={() => set编辑(false)}
      />
      {o.contract && (
        <ContractForm
          open={改签约}
          customerId={o.customer.id}
          editing={{ ...o.contract, order: { id: o.id, no: o.no, payment: o.payment, supplier: o.采购?.supplierName ?? null } }}
          onClose={(saved) => {
            set改签约(false);
            if (saved) router.refresh();
          }}
        />
      )}
    </>
  );
}

type 跑法 = <T extends { ok: boolean }>(p: Promise<T>, 成?: string) => Promise<boolean>;

/** 选中的那一步：截止日、状态、在这一步记一笔、这一步的记录 */
function NodePanel({ o, 节, 跑 }: { o: 订单详情数据; 节: 订单详情数据["nodes"][number]; 跑: 跑法 }) {
  const [话, set话] = useState("");
  const [忙, set忙] = useState(false);
  const 记录 = o.notes.filter((x) => x.nodeIdx === 节.idx);
  return (
    <div className="ord-node-b">
      <div className="ord-node-row">
        <label className="ord-k">截止日</label>
        <DatePicker
          value={节.dueAt ? dayjs(节.dueAt) : null}
          onChange={(d) => void 跑(saveOrderNode(o.id, 节.idx, { dueAt: d ? d.endOf("day").toISOString() : null }))}
          aria-label="截止日"
          placeholder="排个日子"
        />
        <label className="ord-k">状态</label>
        <Segmented
          value={节.status}
          options={[...节点状态们]}
          onChange={(v) => void 跑(saveOrderNode(o.id, 节.idx, { status: String(v) }))}
        />
      </div>
      {节.status === "已完成" && 节.doneAt && <div className="muted ord-done">{fmtDate(节.doneAt)} 完成</div>}
      <div className="ord-note-new">
        <Input.TextArea
          value={话}
          onChange={(e) => set话(e.target.value)}
          autoSize={{ minRows: 2, maxRows: 6 }}
          maxLength={5000}
          placeholder={`在「${节.name}」这一步记一笔：工厂说哪天货好、货代给的船期、客户的回复……`}
          aria-label="在这一步记一笔"
        />
        <Button
          type="primary"
          loading={忙}
          disabled={!话.trim()}
          onClick={async () => {
            set忙(true);
            const 成 = await 跑(addOrderNodeNote(o.id, 节.idx, 话), "记下了，客户的时间线里也有");
            set忙(false);
            if (成) set话("");
          }}
        >
          记一笔
        </Button>
      </div>
      {记录.length > 0 && (
        <ul className="ord-notes">
          {记录.map((x) => (
            <li key={x.id}>
              <span className="ord-notes-t">{fmtDate(x.occurredAt)} · {x.who}</span>
              <span className="ord-notes-c">{x.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 定金 / 尾款：应收、实收、到账日。改完点保存（和金额相关的东西不做「一改就存」，多一步确认不嫌多） */
function MoneyPanel({ o, 尾款应收, 跑 }: { o: 订单详情数据; 尾款应收: number; 跑: 跑法 }) {
  const [v, setV] = useState({ depositPaid: o.depositPaid, depositAt: o.depositAt, balancePaid: o.balancePaid, balanceAt: o.balanceAt });
  const 改了 = v.depositPaid !== o.depositPaid || v.depositAt !== o.depositAt || v.balancePaid !== o.balancePaid || v.balanceAt !== o.balanceAt;
  const 格 = (标: string, 应: number, 实: number, 日: string | null, 改实: (n: number) => void, 改日: (d: string | null) => void) => (
    <div className="ord-money-row">
      <span className="ord-k">{标}</span>
      <span className="ord-money-due">应收 <b>{金额(应, o.currency)}</b></span>
      <InputNumber<number> min={0} value={实} onChange={(n) => 改实(n ?? 0)} formatter={金额格式} aria-label={`${标}实收`} prefix="实收" style={{ width: 170 }} />
      <DatePicker value={日 ? dayjs(日) : null} onChange={(d) => 改日(d ? d.toISOString() : null)} placeholder="到账日" aria-label={`${标}到账日`} />
    </div>
  );
  return (
    <div className="ord-money">
      {格("定金", o.depositDue, v.depositPaid, v.depositAt, (n) => setV({ ...v, depositPaid: n }), (d) => setV({ ...v, depositAt: d }))}
      {格("尾款", 尾款应收, v.balancePaid, v.balanceAt, (n) => setV({ ...v, balancePaid: n }), (d) => setV({ ...v, balanceAt: d }))}
      <div className="ord-money-foot">
        <span className="muted">尾款应收 = 订单金额 − 定金应收</span>
        <Button type="primary" disabled={!改了} onClick={() => void 跑(saveOrder(o.id, v), "已保存")}>保存</Button>
      </div>
    </div>
  );
}

/** 单据清单：每样四态。新建时按贸易条款给一组默认的，缺的自己加 */
function DocsPanel({ o, 跑 }: { o: 订单详情数据; 跑: 跑法 }) {
  const [新, set新] = useState("");
  return (
    <div className="ord-docs">
      {o.docs.length === 0 && <div className="muted">还没有单据</div>}
      {o.docs.map((d) => (
        <div key={d.id} className={`ord-doc${d.state === "未收" ? "" : " ok"}`}>
          <span className="ord-doc-n">{d.name}</span>
          <Segmented size="small" value={d.state} options={[...单据状态们]} onChange={(v) => void 跑(saveOrderDoc(d.id, String(v)))} />
          <Button type="text" size="small" icon={<DeleteOutlined />} aria-label={`删掉「${d.name}」`} onClick={() => void 跑(deleteOrderDoc(d.id))} />
        </div>
      ))}
      <Space.Compact style={{ width: "100%", marginTop: 8 }}>
        <Input value={新} onChange={(e) => set新(e.target.value)} placeholder="加一样：如 产地证 CO" maxLength={60} onPressEnter={() => 新.trim() && void 跑(addOrderDoc(o.id, 新)).then((ok) => ok && set新(""))} aria-label="加一样单据" />
        <Button icon={<PlusOutlined />} disabled={!新.trim()} onClick={() => void 跑(addOrderDoc(o.id, 新)).then((ok) => ok && set新(""))}>加</Button>
      </Space.Compact>
    </div>
  );
}

/**
 * 采购与毛利（3c）：从哪家采、采购额、汇率 → 这一单赚多少。
 * 汇率只用在这一单上（全站合计照样不换汇）；订单和采购同一种币时不用填汇率。
 */
function PurchasePanel({ o, 供应商, 跑 }: { o: 订单详情数据; 供应商: 供应商选项; 跑: 跑法 }) {
  const 原 = o.采购 ?? { supplierId: null, supplierName: null, cost: 0, currency: "CNY", fxRate: null };
  const [v, setV] = useState({ supplierId: 原.supplierId, cost: 原.cost, currency: 原.currency, fxRate: 原.fxRate });
  const 改了 = v.supplierId !== 原.supplierId || v.cost !== 原.cost || v.currency !== 原.currency || v.fxRate !== 原.fxRate;
  const 利 = 毛利(o, v);
  const 同币 = v.currency === o.currency;
  return (
    <div className="ord-money">
      <div className="ord-money-row">
        <span className="ord-k">供应商</span>
        <Select
          style={{ width: 240 }}
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="从哪家采"
          value={v.supplierId ?? undefined}
          onChange={(x) => setV({ ...v, supplierId: x ?? null })}
          options={供应商.map((s) => ({ value: s.id, label: `${s.name}${s.rating ? ` · ${s.rating}` : ""}` }))}
          aria-label="供应商"
        />
        {v.supplierId && <Link href={`/suppliers/${v.supplierId}`}>看这家 ›</Link>}
      </div>
      <div className="ord-money-row">
        <span className="ord-k">采购额</span>
        <Space.Compact>
          <CurrencySelect value={v.currency} onChange={(c) => setV({ ...v, currency: c })} />
          <InputNumber<number> min={0} value={v.cost} onChange={(n) => setV({ ...v, cost: n ?? 0 })} formatter={金额格式} style={{ width: 160 }} aria-label="采购额" />
        </Space.Compact>
        {!同币 && (
          <>
            <span className="ord-k">汇率 1 {o.currency} =</span>
            <InputNumber<number> min={0} step={0.01} value={v.fxRate} onChange={(n) => setV({ ...v, fxRate: n })} style={{ width: 100 }} aria-label="汇率" />
            <span className="ord-k">{v.currency}</span>
          </>
        )}
      </div>
      <div className="ord-money-foot">
        <span className="ord-profit">
          {利 ? (
            <>毛利 <b className={利.毛利 < 0 ? "ord-late" : undefined}>{金额(利.毛利, 利.币种)}</b>（{利.毛利率}%）</>
          ) : (
            <span className="muted">{v.cost > 0 && !同币 ? "填上汇率就算得出毛利" : "填上采购额就算得出毛利"}</span>
          )}
        </span>
        <Button type="primary" disabled={!改了} onClick={() => void 跑(saveOrderPurchase(o.id, v), "已保存")}>保存</Button>
      </div>
    </div>
  );
}
