"use client";

import DatePicker from "@/components/BusinessDatePicker";

import { isFormValidationError } from "@/lib/form-validation";

import { useEffect, useRef, useState } from "react";
import { Modal, Form, InputNumber, Input, App, Checkbox, Space, AutoComplete, Row, Col } from "antd";
import { dayjs, fmtDate } from "@/lib/utils";
import { 金额 } from "@/lib/currency";
import CurrencySelect from "@/components/CurrencySelect";
import { saveContract, listContractLinks, type 签约联动, type 签约联动结果 } from "../actions";
import { useBusiness } from "@/lib/business-client";
import { 外贸订单 } from "@/lib/business-config";
import { 常用付款方式 } from "@/lib/order";
import { 供应商候选 } from "../../orders/actions";
import { StageTag } from "@/components/ui";
import { 金额格式 } from "@/lib/money-input";
import { 聚焦首项 } from "@/lib/modal-focus";

type 可收尾 = Awaited<ReturnType<typeof listContractLinks>>;

/** 「签约已记录，同时：1 个商机标为赢单、完成 2 条计划」——做了什么就说什么，一样没做就不提 */
function 联动说法(r?: 签约联动结果, 订单 = false): string {
  if (!r) return "";
  const 句 = [
    r.赢单 ? `${r.赢单} 个商机${订单 ? "转为订单" : "标为赢单"}` : "",
    r.完成计划 ? `完成 ${r.完成计划} 条计划` : "",
    r.完成待办 ? `完成 ${r.完成待办} 条待办` : "",
  ].filter(Boolean);
  return 句.length ? `，同时：${句.join("、")}` : "";
}

export type ContractRow = {
  id: string;
  amount: number;
  /** 币种（2026-10-03）。老行没有就当人民币 */
  currency?: string;
  signedAt: string;
  remark: string | null;
  /** 外贸模版下这笔签约就是一张订单（2026-10-05）。没有 = 普通签约，或外贸之前登记的老签约 */
  order?: { id: string; no: string; payment: string | null; supplier: string | null; supplierId?: string | null } | null;
};

/**
 * 从一个商机赢单时打开（2026-10-04 J-090，管道把卡片拖进「赢单成交」）：
 * 金额、币种带这个商机的，「同时标为赢单」只认它、不列这位客户别的商机——拖的是这一张卡，不能顺手把另外几单也标成赢单。
 * 它走 saveContract 的联动赢下来，所以签约和赢单是连着记的（删签约时能退回去，L-007）
 */
export type 赢的商机 = { id: string; name: string; amount: number; currency: string };

export default function ContractForm({
  open,
  customerId,
  editing,
  赢这一单,
  onClose,
}: {
  open: boolean;
  customerId: string;
  editing: ContractRow | null;
  赢这一单?: 赢的商机 | null;
  onClose: (saved: boolean) => void;
}) {
  if (!open) return null;
  return <Inner key={editing?.id ?? 赢这一单?.id ?? "new"} customerId={customerId} editing={editing} 赢这一单={editing ? null : 赢这一单 ?? null} onClose={onClose} />;
}

function Inner({
  customerId,
  editing,
  赢这一单,
  onClose,
}: {
  customerId: string;
  editing: ContractRow | null;
  赢这一单: 赢的商机 | null;
  onClose: (saved: boolean) => void;
}) {
  const { message, modal } = App.useApp();
  const b = useBusiness();
  /**
   * 外贸模版：这一笔就是一张订单（2026-10-05 外贸客户建议，lib/order-contract.ts）。
   * 同一个框，叫法换成订单，多三格：订单号、付款方式、供应商；签约时间叫「订单确认时间」
   */
  const 订单 = 外贸订单(b);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  /** 供应商下拉的候选：库里已有的名字（能选也能填，填个新的就新建一家） */
  const [供应商们, set供应商们] = useState<{ id: string; name: string }[]>([]);
  const [选中供应商, set选中供应商] = useState<string | null>(editing?.order?.supplierId ?? null);
  useEffect(() => {
    if (!订单) return;
    let 还在 = true;
    void 供应商候选().then((r) => { if (还在) set供应商们(r); }).catch(() => undefined);
    return () => { 还在 = false; };
  }, [订单]);
  /*
    登记新签约时顺手收尾（2026-09-28 审查 S3）：这位客户进行中的商机默认勾「同时标为赢单」，
    没完成的计划和待办默认勾「一并完成」。人可以取消勾选，服务端只照勾选的做。
    编辑一笔旧签约不列——那不是「刚签下来」，牵动别的东西只会吓人一跳。
  */
  const [可收, set可收] = useState<可收尾 | null>(null);
  const [勾, set勾] = useState<签约联动>({ 赢单: [], 完成计划: [], 完成待办: [] });
  useEffect(() => {
    if (editing) return;
    let 还在 = true;
    void listContractLinks(customerId).then((r) => {
      if (!还在) return;
      // 从一个商机来的：只赢它，别的商机不列（见 赢的商机）；金额已经带好了，不再按勾选去加
      if (赢这一单) {
        set可收({ ...r, 商机: [] });
        set勾({ 赢单: [赢这一单.id], 完成计划: r.计划.map((x) => x.id), 完成待办: r.待办.map((x) => x.id) });
        return;
      }
      set可收(r);
      set勾({ 赢单: r.商机.map((x) => x.id), 完成计划: r.计划.map((x) => x.id), 完成待办: r.待办.map((x) => x.id) });
      带金额(r.商机.map((x) => x.id), r);
    }).catch(() => { if (还在) message.error("联动事项读取失败，请关闭后重试"); });
    return () => { 还在 = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, editing, 赢这一单]);
  /*
    勾着的商机金额之和先填进「签约金额」——多数时候签的就是那一单，不必再抄一遍。
    人自己动过金额或币种就不再跟着勾选变（同 lib/fill-untouched 的规矩：不覆盖手填）。
    币种跟着商机走；勾着的商机币种不一样（一单美元一单欧元）就不带——加起来是假数字，让人自己填。
  */
  // 不用 form.isFieldTouched：setFieldsValue 也会把格子记成「动过」，第一次带出之后就再也不跟了
  const 手填金额 = useRef(false);
  function 带金额(赢单: string[], r: 可收尾 | null = 可收) {
    if (!r || 手填金额.current) return;
    const 选中 = r.商机.filter((o) => 赢单.includes(o.id));
    const 币种 = [...new Set(选中.map((o) => o.currency))];
    if (币种.length > 1) {
      form.setFieldsValue({ amount: null });
      return;
    }
    const 和 = Math.round(选中.reduce((a, o) => a + o.amount, 0) * 100) / 100;
    form.setFieldsValue({ amount: 和 > 0 ? 和 : null, ...(币种[0] ? { currency: 币种[0] } : {}) });
  }
  const 有可收 = 可收 && 可收.商机.length + 可收.计划.length + 可收.待办.length > 0;

  async function submit(force: boolean) {
    const v = await form.validateFields();
    return saveContract({
      id: editing?.id,
      customerId,
      amount: v.amount,
      currency: v.currency,
      signedAt: v.signedAt.toDate(),
      remark: v.remark ?? null,
      force,
      ...(editing ? {} : { 联动: 勾 }),
      // 候选选中后提交ID；自由输入按名字处理，未修改的旧引用继续保留。
      ...(订单
        ? {
            订单: {
              no: v.no ?? "",
              payment: v.payment ?? null,
              ...(选中供应商 ? { supplierId: 选中供应商 } : {}),
              ...((v.supplier ?? "").trim() !== (editing?.order?.supplier ?? "").trim() || !editing?.order ? { supplier: v.supplier ?? null } : {}),
            },
          }
        : {}),
    });
  }

  async function onOk() {
    if (saving) return;
    setSaving(true);
    try {
      const res = await submit(false);
      if (res.ok) {
        message.success(editing ? "已保存" : 订单 ? `订单${res.订单 ? ` ${res.订单.no}` : ""} 已建好${联动说法(res.联动, true)}` : `签约已记录${联动说法(res.联动)}`);
        onClose(true);
        return;
      }
      if ("error" in res) {
        message.error(res.error);
        return;
      }

      /**
       * 同学员 + 同金额 + 同一天，多半是两个人各录了一次同一笔。
       * 但续费和分期本来就可能同额同日，所以只确认、不硬拦。
       */
      const dup = res.duplicate;
      const 继续 = await modal.confirm({
        title: 订单 ? "这张订单可能已经录过了" : "这笔签约可能已经录过了",
        content: (
          <>
            <div>
              该{b.customer}在 {dayjs(dup.signedAt).format("YYYY-MM-DD")} 已有一笔{" "}
              <b>{金额(dup.amount, dup.currency)}</b> 的{订单 ? "订单" : "签约记录"}
              {dup.remark ? `（备注：${dup.remark}）` : ""}。
            </div>
            <div style={{ marginTop: 8 }}>
              如果这是续费或分期的另一笔，可以继续录入；如果是同一笔，请点取消，
              重复录入会让业绩合计翻倍。
            </div>
          </>
        ),
        okText: "确实是另一笔，继续录入",
        cancelText: "取消",
      });
      if (!继续) return;
      const again = await submit(true);
      if (again.ok) {
        message.success(editing ? "已保存" : 订单 ? `订单${again.订单 ? ` ${again.订单.no}` : ""} 已建好${联动说法(again.联动, true)}` : `签约已记录${联动说法(again.联动)}`);
        onClose(true);
      } else if ("error" in again) message.error(again.error);
    } catch (error) {
      if (!isFormValidationError(error)) message.error("保存失败，请刷新确认结果后重试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      afterOpenChange={聚焦首项}
      open
      title={订单 ? (editing ? `编辑订单${editing.order ? ` ${editing.order.no}` : ""}` : 赢这一单 ? "转为订单" : "新建订单") : editing ? "编辑签约记录" : "登记签约"}
      onCancel={() => onClose(false)}
      onOk={onOk}
      confirmLoading={saving}
      okText="保存"
      cancelText="取消"
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: 8 }}
        initialValues={
          editing
            ? { amount: editing.amount, currency: editing.currency ?? "CNY", signedAt: dayjs(editing.signedAt), remark: editing.remark, no: editing.order?.no, payment: editing.order?.payment ?? undefined, supplier: editing.order?.supplier ?? undefined }
            : 赢这一单
              ? { signedAt: dayjs(), currency: 赢这一单.currency, amount: 赢这一单.amount > 0 ? 赢这一单.amount : undefined, remark: 订单 ? `商机「${赢这一单.name}」转为订单` : `商机「${赢这一单.name}」赢单时登记` }
              : { signedAt: dayjs(), currency: b.currency }
        }
      >
        {赢这一单 && (
          <div className="muted" style={{ marginBottom: 12, lineHeight: 1.7 }}>
            {订单
              ? <>「{赢这一单.name}」转为订单。金额和币种从商机带过来了，填上订单号、付款方式就行。</>
              : <>「{赢这一单.name}」标为赢单。登记一笔签约，业绩才算得进去；不登记就点取消，商机照样是赢单。</>}
          </div>
        )}
        {订单 && (
          <Form.Item
            label="订单号 / PI 号"
            name="no"
            rules={editing?.order ? [{ required: true, whitespace: true, message: "订单号不能空着" }] : []}
            extra={editing?.order ? undefined : editing ? "这笔是切外贸之前登记的：填上订单号、付款方式或供应商，就补成一张订单" : "不填就按日期编一个"}
          >
            <Input maxLength={40} placeholder={editing?.order ? undefined : "选填"} />
          </Form.Item>
        )}
        {/* 币种 + 金额一格（2026-10-03）。label 不再写「（元）」：币种在左边那个框里 */}
        <Form.Item label={订单 ? "订单金额" : "签约金额"} required>
          <Space.Compact style={{ width: "100%" }}>
            <Form.Item name="currency" noStyle>
              <CurrencySelect onChange={() => { 手填金额.current = true; }} />
            </Form.Item>
            <Form.Item name="amount" noStyle rules={[{ required: true, message: 订单 ? "请输入订单金额" : "请输入签约金额" }, { type: "number", min: 0, message: "金额不能为负数" }]}>
              {/* 和商机金额同一个坑：parser 把空串读成 0，清空后再敲会多出一个 0（见 lib/money-input.ts） */}
              <InputNumber<number>
                style={{ width: "100%" }}
                step={1000}
                placeholder="如 19,800"
                formatter={金额格式}
                aria-label={订单 ? "订单金额" : "签约金额"}
                onChange={() => { 手填金额.current = true; }}
              />
            </Form.Item>
          </Space.Compact>
        </Form.Item>
        <Form.Item label={订单 ? "订单确认时间" : "签约时间"} name="signedAt" extra={!editing ? (订单 ? "回填订单确认时间只影响订单金额报表；同时转为订单的商机，其转化时间记录本次操作时间。" : "回填签约日期只影响签约报表；同时标为赢单时，赢单时间记录本次操作时间。") : undefined} rules={[{ required: true, message: 订单 ? "请选择订单确认时间" : "请选择签约时间" }]}>
          <DatePicker style={{ width: "100%" }} />
        </Form.Item>
        {订单 && (
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="付款方式" name="payment">
                <AutoComplete allowClear options={常用付款方式.map((x) => ({ value: x }))} placeholder="如 T/T 30/70" filterOption={(i, o) => String(o?.value ?? "").toLowerCase().includes(i.toLowerCase())} />
              </Form.Item>
            </Col>
            <Col span={12}>
              {/* 能选也能填：填一个新名字就新建一家供应商（lib/order-contract.ts） */}
              <Form.Item label="供应商" name="supplier">
                <AutoComplete
                  allowClear
                  options={供应商们.map((x) => ({ value: x.id, name: x.name, label: 供应商们.filter((s) => s.name === x.name).length > 1 ? `${x.name}（${x.id.slice(-6)}）` : x.name }))}
                  onChange={() => set选中供应商(null)}
                  onSelect={(value, option) => {
                    set选中供应商(value);
                    form.setFieldValue("supplier", option.name);
                  }}
                  placeholder="工厂 / 供应商名称"
                  filterOption={(i, o) => String(o?.name ?? "").toLowerCase().includes(i.toLowerCase())}
                />
              </Form.Item>
            </Col>
          </Row>
        )}
        {/* 备注的提示按这一套是做什么的说（2026-10-05：通用模版原来还写着教培的「课程内容」） */}
        <Form.Item label="备注" name="remark" extra={b.template === "trade" ? "贸易条款、交期、包装唛头等" : b.fields.school === "院校" ? "课程内容、付款方式、分期安排等" : "产品 / 服务内容、付款方式、分期安排等"}>
          <Input.TextArea rows={3} placeholder="选填" />
        </Form.Item>
        {有可收 && (
          <div className="contract-links">
            {可收.商机.length > 0 && (
              <div className="contract-links-g">
                <div className="contract-links-t">{订单 ? "同时标为已转订单" : "同时标为赢单"}</div>
                <Checkbox.Group
                  value={勾.赢单}
                  onChange={(v) => { set勾({ ...勾, 赢单: v as string[] }); 带金额(v as string[]); }}
                  options={可收.商机.map((o) => ({
                    value: o.id,
                    label: (
                      <span className="contract-links-i">
                        <span>{o.name}</span>
                        <StageTag stage={o.stage} />
                        <span className="contract-links-m">{金额(o.amount, o.currency)}</span>
                      </span>
                    ),
                  }))}
                />
              </div>
            )}
            {可收.计划.length + 可收.待办.length > 0 && (
              <div className="contract-links-g">
                <div className="contract-links-t">没做完的计划和待办，一并完成</div>
                <Checkbox.Group
                  value={[...勾.完成计划, ...勾.完成待办]}
                  onChange={(v) => {
                    const 选 = new Set(v as string[]);
                    set勾({ ...勾, 完成计划: 可收.计划.filter((x) => 选.has(x.id)).map((x) => x.id), 完成待办: 可收.待办.filter((x) => 选.has(x.id)).map((x) => x.id) });
                  }}
                  options={[
                    ...可收.计划.map((x) => ({
                      value: x.id,
                      label: <span className="contract-links-i"><span>计划 · {x.subject}</span><span className="contract-links-m">{fmtDate(x.plannedAt)}</span></span>,
                    })),
                    ...可收.待办.map((x) => ({
                      value: x.id,
                      label: <span className="contract-links-i"><span>待办 · {x.title}</span>{x.dueAt && <span className="contract-links-m">{fmtDate(x.dueAt)}</span>}</span>,
                    })),
                  ]}
                />
              </div>
            )}
          </div>
        )}
      </Form>
    </Modal>
  );
}
