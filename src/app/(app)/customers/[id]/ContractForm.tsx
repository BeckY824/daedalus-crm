"use client";

import { useEffect, useRef, useState } from "react";
import { Modal, Form, InputNumber, DatePicker, Input, App, Checkbox } from "antd";
import { dayjs, money, fmtDate } from "@/lib/utils";
import { saveContract, listContractLinks, type 签约联动, type 签约联动结果 } from "../actions";
import { useBusiness } from "@/lib/business-client";
import { StageTag } from "@/components/ui";
import { 金额格式 } from "@/lib/money-input";

type 可收尾 = Awaited<ReturnType<typeof listContractLinks>>;

/** 「签约已记录，同时：1 个商机标为赢单、完成 2 条计划」——做了什么就说什么，一样没做就不提 */
function 联动说法(r?: 签约联动结果): string {
  if (!r) return "";
  const 句 = [
    r.赢单 ? `${r.赢单} 个商机标为赢单` : "",
    r.完成计划 ? `完成 ${r.完成计划} 条计划` : "",
    r.完成待办 ? `完成 ${r.完成待办} 条待办` : "",
  ].filter(Boolean);
  return 句.length ? `，同时：${句.join("、")}` : "";
}

export type ContractRow = {
  id: string;
  amount: number;
  signedAt: string;
  remark: string | null;
};

export default function ContractForm({
  open,
  customerId,
  editing,
  onClose,
}: {
  open: boolean;
  customerId: string;
  editing: ContractRow | null;
  onClose: (saved: boolean) => void;
}) {
  if (!open) return null;
  return <Inner key={editing?.id ?? "new"} customerId={customerId} editing={editing} onClose={onClose} />;
}

function Inner({
  customerId,
  editing,
  onClose,
}: {
  customerId: string;
  editing: ContractRow | null;
  onClose: (saved: boolean) => void;
}) {
  const { message, modal } = App.useApp();
  const b = useBusiness();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
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
      set可收(r);
      set勾({ 赢单: r.商机.map((x) => x.id), 完成计划: r.计划.map((x) => x.id), 完成待办: r.待办.map((x) => x.id) });
      带金额(r.商机.map((x) => x.id), r);
    });
    return () => { 还在 = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, editing]);
  /*
    勾着的商机金额之和先填进「签约金额」——多数时候签的就是那一单，不必再抄一遍。
    人自己动过金额就不再跟着勾选变（同 lib/fill-untouched 的规矩：不覆盖手填）。
  */
  // 不用 form.isFieldTouched：setFieldsValue 也会把格子记成「动过」，第一次带出之后就再也不跟了
  const 手填金额 = useRef(false);
  function 带金额(赢单: string[], r: 可收尾 | null = 可收) {
    if (!r || 手填金额.current) return;
    const 和 = r.商机.filter((o) => 赢单.includes(o.id)).reduce((a, o) => a + o.amount, 0);
    form.setFieldsValue({ amount: 和 > 0 ? 和 : null });
  }
  const 有可收 = 可收 && 可收.商机.length + 可收.计划.length + 可收.待办.length > 0;

  async function submit(force: boolean) {
    const v = await form.validateFields();
    return saveContract({
      id: editing?.id,
      customerId,
      amount: v.amount,
      signedAt: v.signedAt.toDate(),
      remark: v.remark ?? null,
      force,
      ...(editing ? {} : { 联动: 勾 }),
    });
  }

  async function onOk() {
    setSaving(true);
    try {
      const res = await submit(false);
      if (res.ok) {
        message.success(editing ? "已保存" : `签约已记录${联动说法(res.联动)}`);
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
      modal.confirm({
        title: "这笔签约可能已经录过了",
        content: (
          <>
            <div>
              该{b.customer}在 {dayjs(dup.signedAt).format("YYYY-MM-DD")} 已有一笔{" "}
              <b>{money(dup.amount)}</b> 的签约记录
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
        async onOk() {
          const again = await submit(true);
          if (again.ok) {
            message.success(editing ? "已保存" : `签约已记录${联动说法(again.联动)}`);
            onClose(true);
          } else if ("error" in again) {
            message.error(again.error);
          }
        },
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      title={editing ? "编辑签约记录" : "登记签约"}
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
            ? { amount: editing.amount, signedAt: dayjs(editing.signedAt), remark: editing.remark }
            : { signedAt: dayjs() }
        }
      >
        <Form.Item label="签约金额（元）" name="amount" rules={[{ required: true, message: "请输入签约金额" }]}>
          {/* 和商机金额同一个坑：parser 把空串读成 0，清空后再敲会多出一个 0（见 lib/money-input.ts） */}
          <InputNumber<number>
            style={{ width: "100%" }}
            min={0}
            step={1000}
            prefix="¥"
            placeholder="如 19,800"
            formatter={金额格式}
            onChange={() => { 手填金额.current = true; }}
          />
        </Form.Item>
        <Form.Item label="签约时间" name="signedAt" rules={[{ required: true, message: "请选择签约时间" }]}>
          <DatePicker style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item label="备注" name="remark" extra="课程内容、付款方式、分期安排等">
          <Input.TextArea rows={3} placeholder="选填" />
        </Form.Item>
        {有可收 && (
          <div className="contract-links">
            {可收.商机.length > 0 && (
              <div className="contract-links-g">
                <div className="contract-links-t">同时标为赢单</div>
                <Checkbox.Group
                  value={勾.赢单}
                  onChange={(v) => { set勾({ ...勾, 赢单: v as string[] }); 带金额(v as string[]); }}
                  options={可收.商机.map((o) => ({
                    value: o.id,
                    label: (
                      <span className="contract-links-i">
                        <span>{o.name}</span>
                        <StageTag stage={o.stage} />
                        <span className="contract-links-m">{money(o.amount)}</span>
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
