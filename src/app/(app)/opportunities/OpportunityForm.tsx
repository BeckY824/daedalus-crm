"use client";

import DatePicker from "@/components/BusinessDatePicker";

import { requiredText } from "@/lib/form-validation";

import { useEffect, useRef, useState } from "react";
import { Input, Modal, Form, Row, Col, InputNumber, Select, Slider, App, Space } from "antd";
import { OPP_STAGES, STAGE_PROBABILITY } from "@/lib/constants";
import { dayjs, 成员选项, 独自一人, type 可选成员 } from "@/lib/utils";
import { 金额格式 } from "@/lib/money-input";
import { saveOpportunity, 读报价 } from "./actions";
import QuoteLines, { 新行, 交出去, 草稿合计, type 草稿行 } from "./QuoteLines";
import type { 一次报价 } from "@/lib/quote-db";
import { 报价明细 } from "@/lib/features";
import type { OppRow } from "./OpportunitiesView";
import { 聚焦首项 } from "@/lib/modal-focus";
import CurrencySelect from "@/components/CurrencySelect";
import { useMe, 默认负责人 } from "@/lib/me-client";
import { useBusiness } from "@/lib/business-client";
import { stageLabel, 外贸订单, 外贸精简 } from "@/lib/business-config";

/**
 * 新建 / 编辑商机的框。列表页和管道页共用（2026-09-29）：管道页原来没有表单，
 * 点「新建商机」要跳回列表页再打开——按钮写着新建，人却被带走了。
 *
 * **样子和字段顺序别动**：教程第 07 集就是在列表页点「新建商机」、依次填名称、选客户、写金额录的，
 * 这里只是把那一块原样挪出来。
 */
export default function OpportunityForm({
  open,
  editing,
  users,
  customers,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: OppRow | null;
  users: 可选成员[];
  customers: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { message } = App.useApp();
  const b = useBusiness();
  /** 外贸模版：摆询盘时间，不摆预计成交和成交概率（2026-10-05 外贸客户建议） */
  const 外贸 = 外贸精简(b);
  const 我 = useMe();
  const [form] = Form.useForm();
  /** 换阶段前是哪一档：概率还等于那一档的默认值，才算「人没动过」、跟着换（排查 D6） */
  const 上一个阶段 = useRef("初步沟通");
  /*
    报价明细（2026-10-03）。编辑时打开框再去取（列表一次 300 个商机，不在那时候带）；
    没取回来之前不往服务端交报价——交一个空表会被当成「清空了明细」另记一版。
  */
  /*
    这一次打开框的报价状态。「这一次」用 会话 认：开 / 关、换了一个商机，就换一份新的。
    在渲染时比对重置（React 的「随 props 变的状态」写法），不在 effect 里同步 setState——那会多渲染一轮。
  */
  const 会话 = open ? (editing?.id ?? "new") : "";
  const [报价态, set报价态] = useState(() => ({ 会话, 行: [] as 草稿行[], 历次: [] as 一次报价[], 到了: !editing }));
  if (报价态.会话 !== 会话) set报价态({ 会话, 行: [], 历次: [], 到了: !editing });
  const { 行, 历次, 到了: 报价到了 } = 报价态;
  /** 金额跟着明细合计走，人自己改过金额就不再跟（含税、折扣、运费另算都可能）。同 lib/fill-untouched 的规矩 */
  const 手填金额 = useRef(false);
  const 币种 = (Form.useWatch("currency", form) as string | undefined) ?? b.currency;
  const 客户 = Form.useWatch("customerId", form) as string | undefined;

  function 改明细(新: 草稿行[]) {
    set报价态((x) => ({ ...x, 行: 新 }));
    const 合 = 草稿合计(新);
    if (!手填金额.current && 合 > 0) form.setFieldValue("amount", 合);
  }

  useEffect(() => {
    手填金额.current = false;
    if (!报价明细 || !open || !editing) return;
    let 还在 = true;
    void 读报价(editing.id).then((qs) => {
      if (!还在) return;
      const 当前 = qs[0]?.行 ?? [];
      // 金额和明细合计对不上：说明人手改过（或者先有金额后补的明细），以后不替他改
      手填金额.current = 当前.length > 0 && Math.abs((qs[0]?.合计 ?? 0) - editing.amount) > 0.005;
      set报价态({
        会话: editing.id,
        历次: qs,
        行: 当前.map((r) => 新行({ product: r.product, spec: r.spec ?? "", qty: r.qty, unit: r.unit ?? "", unitPrice: r.unitPrice })),
        到了: true,
      });
    });
    return () => { 还在 = false; };
  }, [open, editing]);

  useEffect(() => {
    if (!open) return;
    上一个阶段.current = editing?.stage ?? "初步沟通";
    if (editing) {
      form.setFieldsValue({
        ...editing,
        expectedDealAt: editing.expectedDealAt ? dayjs(editing.expectedDealAt) : null,
        询盘时间: dayjs(editing.createdAt),
      });
    } else {
      form.resetFields();
      // 金额不给默认值：原来默认 ¥100,000，忘了改就平白多出一单十万，直接进总额和加权预测
      form.setFieldsValue({
        stage: "初步沟通",
        status: "OPEN",
        probability: STAGE_PROBABILITY["初步沟通"] ?? 20,
        /*
          默认是我（团队同步之后候选里有同事，排第一的不一定是我）。我不在候选里（网页多人版管理员不做销售）就留空让人选，
          不兜底到名单第一人：原来 ?? users[0]，管理员建的商机默认全记到排第一的销售名下（2026-10-04 T-025）。
          只有一个人时这一格不显示，服务端用 唯一负责人() 填
        */
        ownerId: 默认负责人(我, users),
        // 新建默认本位币（设置 → 业务里定的；外贸模版是美元）
        currency: b.currency,
        询盘时间: dayjs(),
      });
    }
  }, [open, editing, form, users, b.currency, 我]);


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
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const res = await saveOpportunity({
      id: editing?.id,
      版本: editing?.updatedAt,
      ...v,
      // 外贸摆询盘时间、不摆预计成交（没摆的格子 validateFields 不给值：预计成交照原样交回去）
      expectedDealAt: 外贸 ? editing?.expectedDealAt ?? null : v.expectedDealAt ? v.expectedDealAt.toISOString() : null,
      询盘时间: 外贸 && v.询盘时间 ? v.询盘时间.toISOString() : undefined,
      // 报价明细关着（lib/features.ts）：不交 = 不碰报价
      ...(报价明细 && 报价到了 ? { 报价: 交出去(行) } : {}),
    });
    if (!res.ok) {
      message.error(res.error);
      return;
    }
    message.success(editing ? "已保存" : "商机已创建");
    onSaved();
  }

  return (
    <Modal
      afterOpenChange={聚焦首项}
      open={open}
      title={editing ? "编辑商机" : "新建商机"}
      onCancel={onClose}
      onOk={onOk} confirmLoading={存着}
      okText="保存"
      cancelText="取消"
      width={760}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
        <Row gutter={16}>
          <Col span={24}>
            <Form.Item name="name" label="商机名称" rules={[requiredText("请填写商机名称")]}>
              <Input placeholder={b.template === "trade" ? "如：LED 面板灯 2000 pcs 询盘" : "如：CRM 系统企业版年度采购"} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="customerId" label="所属客户" rules={[{ required: true, message: "请选择客户" }]}>
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="选择客户"
                options={customers.map((c) => ({ value: c.id, label: c.name }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            {/* 币种 + 金额一格（2026-10-03），和签约框同一个样子 */}
            <Form.Item label="商机金额" required>
              <Space.Compact style={{ width: "100%" }}>
                <Form.Item name="currency" noStyle>
                  <CurrencySelect />
                </Form.Item>
                <Form.Item name="amount" noStyle rules={[{ required: true, message: "请填写商机金额" }]}>
                  <InputNumber<number>
                    min={0}
                    step={10000}
                    style={{ width: "100%" }}
                    placeholder="如 50,000"
                    formatter={金额格式}
                    aria-label="商机金额"
                    onChange={() => { 手填金额.current = true; }}
                  />
                </Form.Item>
              </Space.Compact>
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="stage" label="阶段" extra={外贸订单(b) && editing?.status !== "WON" ? "客户确认了，在商机列表里点「转为订单」" : undefined}>
              <Select
                /* 外贸：赢单成交（客户确认）= 转为订单，要走订单框记下订单号和金额——这里直接选只会得到一张没有订单的「已转订单」（2026-10-05 复查） */
                options={OPP_STAGES.filter((s) => !外贸订单(b) || s !== "赢单成交" || editing?.stage === "赢单成交").map((s) => ({ value: s, label: stageLabel(b, s) }))}
                /*
                  和拖拽同一个规矩（moveStage）：概率只在人没动过时跟着阶段变，手填的 75% 不冲掉；
                  原来一换阶段就覆盖（排查 D6）。赢单成交一律 100
                */
                onChange={(v: string) => {
                  const 现在 = form.getFieldValue("probability") as number | undefined;
                  const 人没动过 = 现在 == null || 现在 === (STAGE_PROBABILITY[上一个阶段.current] ?? 20);
                  if (v === "赢单成交") form.setFieldValue("probability", 100);
                  else if (人没动过 || 上一个阶段.current === "赢单成交") form.setFieldValue("probability", STAGE_PROBABILITY[v] ?? 20);
                  // 阶段和状态当场对上（服务端 对齐阶段与状态 同一个规矩），保存前人就看得见会存成什么
                  if (v === "赢单成交") form.setFieldValue("status", "WON");
                  else if (form.getFieldValue("status") === "WON") form.setFieldValue("status", "OPEN");
                  上一个阶段.current = v;
                }}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="status" label="状态">
              <Select
                onChange={(v: string) => {
                  const 阶段 = form.getFieldValue("stage") as string;
                  if (v === "WON" && 阶段 !== "赢单成交") {
                    form.setFieldValue("stage", "赢单成交");
                    form.setFieldValue("probability", 100);
                    上一个阶段.current = "赢单成交";
                  } else if (v !== "WON" && 阶段 === "赢单成交") {
                    // 赢了的单后来黄了：阶段退回前一档，不能挂在「赢单成交」上
                    const 前一档 = OPP_STAGES[OPP_STAGES.indexOf("赢单成交") - 1];
                    form.setFieldValue("stage", 前一档);
                    form.setFieldValue("probability", STAGE_PROBABILITY[前一档] ?? 20);
                    上一个阶段.current = 前一档;
                  }
                }}
                options={[
                  { value: "OPEN", label: "进行中" },
                  // 外贸：「已转订单」只从「转为订单」来（同上），已经是的照样摆着
                  ...(!外贸订单(b) || editing?.status === "WON" ? [{ value: "WON", label: 外贸订单(b) ? "已转订单" : "已赢单" }] : []),
                  { value: "LOST", label: "已丢单" },
                ]}
              />
            </Form.Item>
          </Col>
          {/* 只有一个人时不问归属，见 lib/utils.ts 的 独自一人 */}
          {!独自一人(users, editing?.ownerId) && (
            <Col span={8}>
              <Form.Item name="ownerId" label="负责人" rules={[{ required: true }]}>
                {/* 现任不在候选里（管理员、已停用）时补进去，不然下拉显示一串 id，一保存还可能被换掉（排查 D8） */}
                <Select
                  options={[
                    ...(editing && !users.some((u) => u.id === editing.ownerId)
                      ? [{ value: editing.ownerId, label: `${editing.ownerName}（不在候选里）` }]
                      : []),
                    ...成员选项(users),
                  ]}
                />
              </Form.Item>
            </Col>
          )}
          {外贸 ? (
            <Col span={8}>
              {/* 外贸客户：「同一个需求 3 月问了一次没成，5 月又问一次，这样可以知道客户计划采购的时间点」 */}
              <Form.Item name="询盘时间" label="询盘时间" extra="这次询盘是哪天来的，补录以前的询盘时改成当天">
                <DatePicker style={{ width: "100%" }} allowClear={false} disabledDate={(d) => d.isAfter(dayjs(), "day")} />
              </Form.Item>
              {/* 概率不摆（外贸客户：没有意义），值照样跟着阶段走：漏斗、数据页还按它算 */}
              <Form.Item name="probability" hidden><Slider /></Form.Item>
            </Col>
          ) : (
            <>
              <Col span={8}>
                <Form.Item name="expectedDealAt" label="预计成交">
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col span={16}>
                <Form.Item name="probability" label="成交概率 (%)">
                  <Slider marks={{ 0: "0", 50: "50", 100: "100" }} />
                </Form.Item>
              </Col>
            </>
          )}
          {报价明细 && (
            <Col span={24}>
              <Form.Item label="报价明细" style={{ marginBottom: 16 }}>
                <QuoteLines 行={行} onChange={改明细} currency={币种} customerId={客户} opportunityId={editing?.id} 历次={历次} />
              </Form.Item>
            </Col>
          )}
          <Col span={24}>
            <Form.Item name="remark" label="备注">
              <Input.TextArea rows={2} placeholder="竞争对手、决策周期、风险点…" />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
