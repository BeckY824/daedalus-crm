"use client";

import DatePicker from "@/components/BusinessDatePicker";

import { useEffect, useState } from "react";
import { App, AutoComplete, Button, Checkbox, Col, Drawer, Form, Input, InputNumber, Modal, Row, Segmented, Space, Table, Tag, Tooltip } from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, WarningOutlined } from "@ant-design/icons";
import CurrencySelect from "@/components/CurrencySelect";
import { 金额, 币种符号 } from "@/lib/currency";
import { dayjs, fmtDate } from "@/lib/utils";
import { 结论们, 要理由, 最低价, 建议报价, 过期了, 至少问几家 } from "@/lib/supplier";
import { 聚焦首项 } from "@/lib/modal-focus";
import { 读比价, saveSupplierQuote, deleteSupplierQuote } from "../suppliers/actions";

type 数据 = Awaited<ReturnType<typeof 读比价>>;
type 行 = 数据["行"][number];

const 结论色: Record<string, string> = { 选用: "success", 备选: "processing", 淘汰: "default", 待定: "warning" };

/** 建议报价那两格（汇率、目标毛利率）记在本机：一个人的习惯，换个询盘不用再敲一遍 */
const 算法键 = "crm.compareCalc";
function 读算法(): { 汇率: number | null; 毛利率: number | null } {
  try {
    const v = JSON.parse(localStorage.getItem(算法键) ?? "{}");
    return { 汇率: typeof v.汇率 === "number" ? v.汇率 : null, 毛利率: typeof v.毛利率 === "number" ? v.毛利率 : null };
  } catch {
    return { 汇率: null, 毛利率: null };
  }
}

/**
 * 供应商比价（2026-10-03 外贸第 3c 块）：一个询盘问了哪几家、每家多少、选了谁、为什么。
 *
 * 一家一行。同一个产品、同币种同含票口径里最低的那一行标绿（含票和不含票不比——便宜的多半是没算票）。
 * 结论「选用」「淘汰」必须写理由：那是比价表上唯一给老板看的那一格。
 * 顶上两格算建议报价：出厂价 ÷ 汇率 ÷ (1 − 目标毛利率)，运费另算。
 * 只问了一家的提醒一句：贸易公司的毛利就在「找对工厂」这一步。
 */
export default function CompareDrawer({ open, opp, onClose }: { open: boolean; opp: { id: string; name: string; currency: string } | null; onClose: () => void }) {
  const { message } = App.useApp();
  const [数, set数] = useState<数据 | null>(null);
  const [编辑, set编辑] = useState<行 | "new" | null>(null);
  const [算, set算] = useState<{ 汇率: number | null; 毛利率: number | null }>({ 汇率: null, 毛利率: null });

  async function 拉() {
    if (!opp) return;
    set数(await 读比价(opp.id));
  }
  useEffect(() => {
    if (!open || !opp) return;
    let 还在 = true;
    void 读比价(opp.id).then((d) => 还在 && set数(d));
    return () => { 还在 = false; };
  }, [open, opp]);
  // 本机记的算法在打开时读一次（SSR 时 localStorage 不在）
  useEffect(() => {
    if (open) queueMicrotask(() => set算(读算法()));
  }, [open]);
  function 改算(x: Partial<typeof 算>) {
    const 新 = { ...算, ...x };
    set算(新);
    try { localStorage.setItem(算法键, JSON.stringify(新)); } catch { /* 存不下就算了 */ }
  }

  const 行们 = 数?.行 ?? [];
  const 低 = 最低价(行们);
  const 家数 = new Set(行们.map((r) => r.supplierId)).size;

  async function 删(r: 行) {
    const res = await deleteSupplierQuote(r.id);
    if (!res.ok) return message.error(res.error);
    message.success("删了这一行");
    await 拉();
  }

  return (
    <Drawer open={open} onClose={onClose} styles={{ wrapper: { width: 1000, maxWidth: "100vw" } }} title={opp ? `供应商比价 · ${opp.name}` : "供应商比价"} destroyOnHidden>
      <div className="cmp-top">
        {行们.length > 0 && 家数 < 至少问几家 && (
          <span className="cmp-warn"><WarningOutlined /> 只问了 {家数} 家，至少问 {至少问几家} 家再定</span>
        )}
        <span className="cmp-calc">
          建议报价 = 出厂价 ÷
          <InputNumber<number> size="small" min={0} step={0.01} value={算.汇率} onChange={(v) => 改算({ 汇率: v })} placeholder="汇率" aria-label="汇率" style={{ width: 90 }} />
          （1 {opp?.currency ?? "USD"} 折多少出厂价币种）÷ (1 −
          <InputNumber<number> size="small" min={0} max={95} value={算.毛利率 === null ? null : Math.round(算.毛利率 * 100)} onChange={(v) => 改算({ 毛利率: v === null ? null : v / 100 })} placeholder="毛利" aria-label="目标毛利率" suffix="%" style={{ width: 80 }} />
          )，运费另算
        </span>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => set编辑("new")}>加一家报价</Button>
      </div>

      <Table<行>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={行们}
        loading={数 === null}
        rowClassName={(r) => [低.has(r.id) ? "cmp-low" : "", 过期了(r.validUntil) ? "cmp-old" : ""].join(" ")}
        locale={{ emptyText: "还没有比价。点「加一家报价」，把问到的价一家一行记下来" }}
        columns={[
          {
            title: "供应商", key: "s", width: 140,
            render: (_, r) => (
              <Space size={4}>
                <span>{r.supplier.name}</span>
                {r.supplier.rating && <Tag style={{ margin: 0 }}>{r.supplier.rating}</Tag>}
                {r.supplier.issues && <Tooltip title={`出过的问题：${r.supplier.issues}`}><WarningOutlined className="cmp-issue" aria-label="出过问题" /></Tooltip>}
              </Space>
            ),
          },
          { title: "产品", dataIndex: "product", key: "product", width: 120 },
          {
            title: "出厂价", key: "p", width: 140,
            render: (_, r) => (
              <span className="cmp-price">
                {金额(r.unitPrice, r.currency)} <span className="muted">{r.withInvoice ? "含票" : "不含票"}</span>
                {低.has(r.id) && <Tag color="success" style={{ marginLeft: 4 }}>最低</Tag>}
              </span>
            ),
          },
          { title: "MOQ", dataIndex: "moq", key: "moq", width: 60, render: (v: number | null) => v ?? "—" },
          { title: "交期", dataIndex: "leadDays", key: "lead", width: 60, render: (v: number | null) => (v != null ? `${v} 天` : "—") },
          { title: "有效期", dataIndex: "validUntil", key: "valid", width: 96, render: (v: string | null) => (v ? <span title={过期了(v) ? "过期了，这个价不一定还作数" : undefined}>{fmtDate(v)}{过期了(v) ? " 过期" : ""}</span> : "—") },
          {
            title: "建议报价", key: "sug", width: 90,
            render: (_, r) => {
              const v = 建议报价(r.unitPrice, 算.汇率, 算.毛利率);
              return v === null ? <span className="muted">填汇率</span> : 金额(v, opp?.currency ?? "USD");
            },
          },
          {
            title: "结论", key: "v",
            render: (_, r) => (
              <span>
                <Tag color={结论色[r.verdict]} style={{ margin: 0 }}>{r.verdict}</Tag>
                {r.reason && <span className="cmp-reason"> {r.reason}</span>}
              </span>
            ),
          },
          {
            title: "", key: "act", width: 64,
            render: (_, r) => (
              <Space size={0}>
                <Button type="text" size="small" icon={<EditOutlined />} aria-label={`编辑 ${r.supplier.name} 的报价`} onClick={() => set编辑(r)} />
                <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`删掉 ${r.supplier.name} 的报价`} onClick={() => void 删(r)} />
              </Space>
            ),
          },
        ]}
      />

      {编辑 && opp && 数 && (
        <QuoteRowForm
          opp={opp}
          editing={编辑 === "new" ? null : 编辑}
          供应商={数.供应商}
          产品={数.产品}
          onClose={async (存了) => {
            set编辑(null);
            if (存了) await 拉();
          }}
        />
      )}
    </Drawer>
  );
}

function QuoteRowForm({
  opp, editing, 供应商, 产品, onClose,
}: {
  opp: { id: string; name: string; currency: string };
  editing: 行 | null;
  供应商: 数据["供应商"];
  产品: string[];
  onClose: (存了: boolean) => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const 结论 = Form.useWatch("verdict", form) as string | undefined;
  const 币 = (Form.useWatch("currency", form) as string | undefined) ?? "CNY";

  // 保存中不再收第二下：网慢、连着团队时连点几下会建出几条一样的（10-07 Sam 实测建出三条重复商机）
  const [存着, set存着] = useState(false);
  async function onOk() {
    if (存着) return;
    set存着(true);
    try {
      await 存();
    } finally {
      set存着(false);
    }
  }
  async function 存() {
    // 校验没过：框里各格已经标红了，安静返回；不接住的话是一个没人处理的 Promise 拒绝
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const 认得 = 供应商.find((s) => s.name === String(v.supplier ?? "").trim());
    const r = await saveSupplierQuote({
      id: editing?.id,
      opportunityId: opp.id,
      supplierId: 认得?.id ?? null,
      supplierName: 认得 ? null : v.supplier,
      product: v.product,
      unitPrice: v.unitPrice,
      currency: v.currency,
      withInvoice: !!v.withInvoice,
      moq: v.moq ?? null,
      leadDays: v.leadDays ?? null,
      sampleFee: v.sampleFee ?? null,
      validUntil: v.validUntil ? v.validUntil.endOf("day").toISOString() : null,
      verdict: v.verdict,
      reason: v.reason ?? null,
    });
    if (!r.ok) return message.error(r.error);
    message.success("记下了");
    onClose(true);
  }

  return (
    <Modal open title={editing ? "改这家的报价" : "加一家报价"} onCancel={() => onClose(false)} onOk={onOk} confirmLoading={存着} okText="保存" cancelText="取消" width={620} afterOpenChange={聚焦首项} destroyOnHidden>
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: 8 }}
        initialValues={
          editing
            ? { ...editing, supplier: editing.supplier.name, validUntil: editing.validUntil ? dayjs(editing.validUntil) : null }
            : { currency: "CNY", withInvoice: true, verdict: "待定", product: 产品.length === 1 ? 产品[0] : undefined }
        }
      >
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="supplier" label="供应商" rules={[{ required: true, whitespace: true, message: "选一家，或写个名字" }]} extra="没建过档的直接写名字，会顺手建一家">
              <AutoComplete options={供应商.map((s) => ({ value: s.name, label: `${s.name}${s.rating ? ` · ${s.rating}` : ""}${s.issues ? " · 出过问题" : ""}` }))} filterOption={(i, o) => String(o?.value ?? "").toLowerCase().includes(i.toLowerCase())} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="product" label="产品" rules={[{ required: true, whitespace: true, message: "写产品" }]} extra={产品.length ? "下拉里是这个商机报价明细里的产品" : undefined}>
              <AutoComplete options={产品.map((p) => ({ value: p }))} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="出厂单价" required>
              <Space.Compact style={{ width: "100%" }}>
                <Form.Item name="currency" noStyle><CurrencySelect /></Form.Item>
                <Form.Item name="unitPrice" noStyle rules={[{ required: true, message: "填出厂价" }]}>
                  <InputNumber<number> min={0} style={{ width: "100%" }} aria-label="出厂单价" />
                </Form.Item>
              </Space.Compact>
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="withInvoice" label="口径" valuePropName="checked" extra="含 13% 票才能退税；比价时只和同口径的比">
              <Checkbox>含票</Checkbox>
            </Form.Item>
          </Col>
          <Col span={6}><Form.Item name="moq" label="MOQ"><InputNumber<number> min={0} style={{ width: "100%" }} /></Form.Item></Col>
          <Col span={6}><Form.Item name="leadDays" label="交期（天）"><InputNumber<number> min={0} precision={0} style={{ width: "100%" }} /></Form.Item></Col>
          <Col span={6}><Form.Item name="sampleFee" label="打样费"><InputNumber<number> min={0} style={{ width: "100%" }} prefix={币种符号(币)} /></Form.Item></Col>
          <Col span={6}><Form.Item name="validUntil" label="有效期至"><DatePicker style={{ width: "100%" }} /></Form.Item></Col>
          <Col span={24}>
            <Form.Item name="verdict" label="结论">
              <Segmented options={[...结论们]} />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item
              name="reason"
              label="理由"
              dependencies={["verdict"]}
              rules={[({ getFieldValue }) => ({ validator: (_, v) => (要理由.includes(getFieldValue("verdict")) && !String(v ?? "").trim() ? Promise.reject(new Error(`「${getFieldValue("verdict")}」要写一句理由`)) : Promise.resolve()) })]}
            >
              <Input placeholder={结论 && 要理由.includes(结论) ? "必填：价格 / 交期 / 质量 / 配合度……" : "选填"} maxLength={500} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
