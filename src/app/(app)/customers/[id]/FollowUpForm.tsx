"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Form, Input, Select, DatePicker, InputNumber, Row, Col, App, Button, Checkbox, Space, Typography } from "antd";
import { ThunderboltOutlined } from "@ant-design/icons";
import { FOLLOW_TYPES, FOLLOW_RECORD_STATUSES } from "@/lib/constants";
import { dayjs, fmtDateTime } from "@/lib/utils";
import { saveFollowUp, saveTask, savePlan, completePlan } from "./actions";
import { parseFollowUpDraft } from "./ai";
import { useBusiness } from "@/lib/business-client";
import { 外贸订单 } from "@/lib/business-config";
import AiWait from "@/components/AiWait";
import AiCost from "@/components/AiCost";
import { clearJob, runJob } from "@/lib/ai-jobs";
import { statusLabel } from "@/lib/business-config";
import { 只填没动过的, 跳过说明 } from "@/lib/fill-untouched";
import CustomerPick, { type 客户近况 } from "./CustomerPick";

/** 「标题你改过，没动」里说的名字：和表单上的标签对得上，说短一点 */
const 字段名: Record<string, string> = {
  type: "类型",
  status: "状态",
  title: "标题",
  content: "内容",
  durationMinutes: "时长",
  occurredAt: "时间",
  contactId: "联系人",
  opportunityId: "商机",
};

type Rec = {
  id?: string;
  type?: string;
  title?: string;
  content?: string;
  status?: string;
  duration?: number | null;
  occurredAt?: string;
  dueAt?: string | null;
  contactId?: string | null;
  opportunityId?: string | null;
  /** 挂在哪张订单上（2026-10-05） */
  orderId?: string | null;
  participants?: string | null;
  /** 编辑时的版本号（J-105）：保存时交回去当闸门 */
  updatedAt?: string;
};

/** AI 速记解析出的"顺带创建"项，勾选后随跟进一起保存 */
type Extras = {
  tasks: { title: string; dueAt: string | null; checked: boolean }[];
  plan: { subject: string; plannedAt: string; method: string; checked: boolean } | null;
  followStatusSuggestion: string | null;
  decisionStatusSuggestion: string | null;
};

/**
 * 跟进表单。两处用：记录页（给了 customerId 和他的联系人、商机）和跟进页页头的「记录跟进」
 * （都不给，第一格挑人，挑中后联系人、商机、到期计划从 CustomerPick 取回来）。只有一份。
 */
/** 「关联商机 / 订单」那一格里订单的值带这个前缀，商机的是光 id */
const 订单前缀 = "订单:";

/**
 * 那一格的值拆成 opportunityId / orderId。不挂订单的模版不交 orderId（= 不碰，老记录挂着的订单原样留着）；
 * 挂订单的模版里选了商机就把订单摘掉、选了订单就不挂商机——一条跟进说的是一件事
 */
function 拆关联(v: string | undefined | null, 挂订单: boolean, 原商机: string | null = null): { opportunityId: string | null; orderId?: string | null } {
  if (!挂订单) return { opportunityId: v ?? null };
  // 选的是订单：原来挂着的商机留着（订单页上记的那几条两样都挂着，编辑一下别把商机悄悄摘掉，2026-10-05 复查）
  if (v && v.startsWith(订单前缀)) return { opportunityId: 原商机, orderId: v.slice(订单前缀.length) };
  return { opportunityId: v ?? null, orderId: null };
}

export default function FollowUpForm({
  open,
  onClose,
  onSaved,
  customerId: 给定客户,
  预选客户,
  record,
  contacts: 给定联系人,
  opportunities: 给定商机,
  orders: 给定订单,
  aiEnabled,
  initialAiText,
  待收口计划 = null,
  完成了计划,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** 记录页上给定；跟进页上不给，改由表单第一格挑 */
  customerId?: string;
  /** 不给 customerId 时预填的那一位（从某位客户带过来的） */
  预选客户?: { id: string; name: string } | null;
  record: Rec | null;
  /** 记录页上给；挑人时用挑中那位的 */
  contacts?: { id: string; name: string; position: string | null }[];
  opportunities?: { id: string; name: string }[];
  /** 这位客户的订单（外贸模版，2026-10-05）：「关联商机 / 订单」那一格的第二组 */
  orders?: { id: string; no: string }[];
  aiEnabled: boolean;
  /** 记录页顶部的速记框直接带过来的原文：打开即解析，少点一次 */
  initialAiText?: string;
  /**
   * 这位客户已经到期（今天或更早）的那条跟进计划（审查 M9）。
   * 记的这一笔多半就是在做那件事，所以新建时默认勾上「同时完成」——原来记完了，
   * 首页照样催「发二版阶梯报价已逾期 4 天」
   */
  待收口计划?: { id: string; subject: string; plannedAt: string; method: string } | null;
  /**
   * 勾着「同时完成」保存之后，由记录页去完成它（提示条里带撤销和排下一次）。
   * 不给（跟进页上挑人时）就由这张表单自己完成，提示条里带撤销和去他记录页的路
   */
  完成了计划?: (p: { id: string; subject: string; plannedAt: string; method: string }) => void;
}) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const router = useRouter();
  const b = useBusiness();
  const type = Form.useWatch("type", form);

  const 挑人 = !给定客户;
  /** 挑中那位的近况：联系人、商机、到期计划都从这儿来。关框、保存时清掉 */
  const [近况, set近况] = useState<客户近况 | null>(null);
  const customerId = 给定客户 ?? 近况?.id;
  const contacts = 给定联系人 ?? 近况?.contacts ?? [];
  const opportunities = 给定商机 ?? 近况?.opportunities ?? [];
  /*
    外贸模版：「关联商机」改成「关联商机 / 订单」（2026-10-05 外贸客户：「里面的选项可以关联到订单号，
    这样就可以对订单执行做跟进的记录了」）。同一格、两组；选订单存的是「订单:<id>」，保存时拆开
  */
  const 挂订单 = 外贸订单(b);
  const orders = 挂订单 ? 给定订单 ?? 近况?.orders ?? [] : [];
  /** 挑人时的「到期计划」和记录页同一个口径：最早那条没做完的，今天或更早到期 */
  const 收口计划 = 挑人
    ? 近况?.未完成计划 && !dayjs(近况.未完成计划.plannedAt).isAfter(dayjs().endOf("day")) ? 近况.未完成计划 : null
    : 待收口计划;

  function 换人(v: 客户近况 | null) {
    set近况(v);
    // 联系人、商机是上一位的，换了人就不作数了（AI 解析填进去的也一样）
    form.setFieldsValue({ contactId: undefined, opportunityId: undefined });
  }

  const [aiText, setAiText] = useState("");
  /** 这一次解析走到哪儿了：null = 没解析过；有「起」没结果 = 跑着 */
  const [解析, set解析] = useState<{ 起: number; 结果?: string; 出错?: string } | null>(null);
  const aiLoading = Boolean(解析 && !解析.结果 && !解析.出错);
  const [extras, setExtras] = useState<Extras | null>(null);
  /** 「同时完成那条到期计划」勾没勾。每次打开都重新默认勾上 */
  const [收口, set收口] = useState(true);
  /*
    解析也登记进任务表（lib/ai-jobs）：要十来秒，人会切去别的应用，
    答完了侧栏那条和系统通知会叫他回来。弹窗关了 = 不要了，任务一起清掉——
    清掉之后模型那边回来的结果不会再写回去，也就不会冒出一条「答完了」。
  */
  const 任务键 = `followup-parse:${customerId}`;
  /** 弹窗在解析途中被关掉：回来的结果没人接，不许再往一个已经关掉的表单里填 */
  const 这一次 = useRef(0);

  // AI 面板的状态在关闭/保存的事件处理里重置（见 resetAi），
  // 不放进 effect——react-hooks/set-state-in-effect 禁止，且事件里重置语义更准
  function resetAi() {
    这一次.current++;
    clearJob(任务键);
    setAiText("");
    setExtras(null);
    set解析(null);
    // 下次打开「同时完成计划」重新默认勾上。在关闭的事件里复位，不放 effect（同上）
    set收口(true);
    set近况(null);
  }

  async function onAiParse() {
    return runParse(aiText);
  }

  async function runParse(text: string) {
    if (!customerId) {
      message.warning(`先挑一位${b.customer}`);
      return;
    }
    if (text.trim().length < 5) {
      message.warning("先把沟通过程随手写几句");
      return;
    }
    const 轮 = ++这一次.current;
    const 起 = Date.now();
    set解析({ 起 });
    const 请求 = parseFollowUpDraft({ customerId, text });
    // 任务表只记「跑着 / 好了 / 出错」给侧栏和系统通知用；草稿本身由下面这条 await 接
    runJob<null>(
      任务键,
      () => 请求.then((r) => (r.ok ? { ok: true as const, value: null } : { ok: false as const, error: r.error })),
      undefined,
      { 名: "解析跟进速记", 去: `/customers/${customerId}` },
    );
    let res: Awaited<typeof 请求>;
    try {
      res = await 请求;
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : "解析失败，请重试" };
    }
    if (轮 !== 这一次.current) return;
    if (!res.ok) {
      set解析({ 起, 出错: res.error });
      return;
    }
    const d = res.draft;
    /*
      只填人没动过的格子（lib/fill-untouched.ts）。解析要十来秒，这期间人可能已经补了标题、改了类型——
      结果回来整个盖掉，他刚写的就没了。「重新解析」同理：上一轮 AI 填的没人碰过，照换；人改过的留着。
    */
    const { 填, 跳过 } = 只填没动过的(
      {
        type: d.followUp.type,
        status: d.followUp.status,
        title: d.followUp.title || undefined,
        content: d.followUp.content,
        durationMinutes: d.followUp.durationMinutes,
        occurredAt: d.followUp.occurredAt ? dayjs(d.followUp.occurredAt) : dayjs(),
        contactId: d.followUp.contactId ?? undefined,
        opportunityId: d.followUp.opportunityId ?? undefined,
      },
      (name) => form.isFieldTouched(name),
    );
    form.setFieldsValue(填);
    setExtras({
      tasks: d.tasks.map((t) => ({ ...t, checked: true })),
      plan: d.plan ? { ...d.plan, checked: true } : null,
      followStatusSuggestion: d.followStatusSuggestion,
      decisionStatusSuggestion: d.decisionStatusSuggestion,
    });
    // 做完留一行摘要在原地，替掉原来那条一闪就走的提示：人一眼看到 AI 认出了什么，再去核对下面的表
    const 摘要 = [
      FOLLOW_TYPES.find((t) => t.value === d.followUp.type)?.label,
      d.followUp.status,
      d.plan?.plannedAt ? `下次 ${dayjs(d.plan.plannedAt).format("M 月 D 日")}` : null,
      d.tasks.length ? `${d.tasks.length} 条待办` : null,
      跳过说明(跳过, 字段名),
      `${((Date.now() - 起) / 1000).toFixed(1)}s`,
    ].filter(Boolean);
    set解析({ 起, 结果: `已预填：${摘要.join(" · ")}` });
  }

  const autoParsed = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      autoParsed.current = null;
      return;
    }
    if (initialAiText && aiEnabled && !record?.id && autoParsed.current !== initialAiText) {
      autoParsed.current = initialAiText;
      setAiText(initialAiText);
      // 解析是异步网络调用，放到下一拍触发，不在 effect 里同步 setState
      const t = setTimeout(() => void runParse(initialAiText), 0);
      return () => clearTimeout(t);
    }
    if (record?.id) {
      form.setFieldsValue({
        ...record,
        opportunityId: record.orderId && 挂订单 ? `${订单前缀}${record.orderId}` : record.opportunityId,
        occurredAt: dayjs(record.occurredAt),
        dueAt: record.dueAt ? dayjs(record.dueAt) : null,
        durationMinutes: record.duration ? Math.round(record.duration / 60) : null,
      });
    } else {
      form.resetFields();
      form.setFieldsValue({
        type: record?.type ?? "PHONE",
        status: "已完成",
        occurredAt: dayjs(),
      });
    }
  }, [open, record, form]);

  /*
    保存中：网慢时连点两下会建出两条一样的记录（跟进带的 AI 待办和计划也各建两份，2026-10-02 排查）。
    校验没过（validateFields 抛出）也会走 finally 放开
  */
  const [存着, set存着] = useState(false);
  async function 保存() {
    if (存着) return;
    set存着(true);
    try {
      await onOk();
    } finally {
      set存着(false);
    }
  }

  async function onOk() {
    const v = await form.validateFields();
    const 谁 = 给定客户 ?? (v.customerId as string);
    const 名 = 近况?.name;
    const res = await saveFollowUp({
      id: record?.id,
      版本: record?.id ? record.updatedAt : null,
      customerId: 谁,
      type: v.type,
      title: v.title,
      content: v.content,
      status: v.status,
      durationMinutes: v.durationMinutes ?? null,
      occurredAt: v.occurredAt.toISOString(),
      dueAt: v.dueAt ? v.dueAt.toISOString() : null,
      contactId: v.contactId ?? null,
      ...拆关联(v.opportunityId, 挂订单, record?.id ? record.opportunityId ?? null : null),
      participants: v.participants ?? null,
      // 经 AI 解析过才带原文：手工写的跟进没有"原文"这个概念
      sourceText: !record?.id && extras ? aiText : null,
    });
    // 校验不通过时必须如实报错，否则界面照样提示成功、人以为已经存下了
    if (!res.ok) {
      message.error(res.error);
      // 撞了版本（J-105）：页面上的数据先刷成最新的，人关框重开就是新的那一版，不然拿着旧版本再存还是被拦
      if (record?.id) router.refresh();
      return;
    }

    // AI 顺带解析出的待办/计划，只创建勾选的；失败不吞——跟进本体已存上，
    // 但要让人知道哪部分要手工补，不能让"部分成功"伪装成"全部成功"
    if (!record?.id && extras) {
      const jobs: Promise<{ ok: boolean }>[] = [];
      for (const t of extras.tasks) {
        if (t.checked) jobs.push(saveTask({ customerId: 谁, title: t.title, dueAt: t.dueAt }));
      }
      if (extras.plan?.checked) {
        jobs.push(
          savePlan({
            customerId: 谁,
            subject: extras.plan.subject,
            plannedAt: extras.plan.plannedAt,
            method: extras.plan.method,
          }),
        );
      }
      if (jobs.length) {
        const results = await Promise.allSettled(jobs);
        const failed = results.filter((r) => r.status === "rejected" || !r.value.ok).length;
        if (failed > 0) {
          message.warning(`跟进已保存，但有 ${failed} 项待办/计划创建失败，请手动补建`);
          resetAi();
          onSaved();
          return;
        }
      }
    }

    const 要收口 = !record?.id && 收口计划 && 收口 ? 收口计划 : null;
    resetAi();
    onSaved();
    // 顺手完成那条到期计划：记录页上提示由它出（带撤销、排下一次），这里就不再单说一句「跟进已记录」
    if (要收口 && 完成了计划) return void 完成了计划(要收口);
    if (!挑人 || !名) {
      if (要收口) await completePlan(要收口.id);
      if ("待办id" in res && res.待办id) {
        // 顺带建了待办：Dock 数和到点提醒要马上跟上
        void window.desktopReminders?.刷新();
        return void message.success("跟进已记录，也加进了待办——到点会提醒你");
      }
      return void message.success(record?.id ? "已保存" : "跟进已记录");
    }

    // 跟进页上挑人记的：人留在原地（新的那行会亮一下），提示里给撤销和去他记录页的路
    if (要收口) {
      await completePlan(要收口.id);
      void window.desktopReminders?.刷新();
    }
    const key = `followup-new-${res.id}`;
    message.success({
      key,
      duration: 6,
      content: (
        <span>
          {要收口 ? `跟进已记录，计划「${要收口.subject}」一并完成` : `已记下和${名}的这次跟进`}
          {要收口 && (
            <Button
              type="link"
              size="small"
              onClick={async () => {
                message.destroy(key);
                await completePlan(要收口.id, false);
                void window.desktopReminders?.刷新();
                message.success(`「${要收口.subject}」已改回未完成`);
                router.refresh();
              }}
            >
              撤销
            </Button>
          )}
          <Button type="link" size="small" onClick={() => { message.destroy(key); router.push(`/customers/${谁}`); }}>
            去{名}的记录页
          </Button>
        </span>
      ),
    });
  }

  const showDuration = type === "PHONE" || type === "MEETING";
  const showDue = type === "TASK" || type === "REMIND";
  const showAi = aiEnabled && !record?.id;
  /** 挑人模式下还没挑：AI 解析要知道是谁（认联系人、商机），先不让点 */
  const 还没挑 = !customerId;
  const suggestions = [
    extras?.followStatusSuggestion ? `跟进状态 → ${statusLabel(b, extras.followStatusSuggestion)}` : null,
    extras?.decisionStatusSuggestion ? `决策状态 → ${statusLabel(b, extras.decisionStatusSuggestion)}` : null,
  ].filter(Boolean);

  return (
    <Modal
      open={open}
      title={record?.id ? "编辑跟进记录" : "新建跟进"}
      onCancel={() => {
        resetAi();
        onClose();
      }}
      onOk={保存}
      confirmLoading={存着}
      okText="保存"
      cancelText="取消"
      width={640}
      destroyOnHidden
    >
      {/* AI 速记块放在 Form 里面（它不是字段）：挑人那一格是 Form.Item，得在它上面、仍是第一格 */}
      <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
        {挑人 && <CustomerPick 预选={预选客户} 近况={近况} on近况={换人} 不提计划={Boolean(收口计划)} />}
        {showAi && (
          <div
            style={{
              background: "var(--brand-bg)",
              border: "1px solid var(--brand-line)",
              borderRadius: 8,
              padding: "12px 14px",
              marginBottom: 8,
            }}
          >
            <Input.TextArea
              value={aiText}
              onChange={(e) => setAiText(e.target.value)}
              autoSize={{ minRows: 2, maxRows: 6 }}
              maxLength={5000}
              placeholder={'跟进速记：把沟通过程随手倒出来，或直接粘贴微信聊天记录，AI 帮你填表。\n如："刚和周总通了 20 分钟电话，他担心交期，想先小批量试一单，下周三再约他聊报价"'}
            />
            <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              {解析 ? (
                <div style={{ flex: 1, minWidth: 0, marginRight: 12 }}>
                  <AiWait 在做="从这段话里认出跟进方式、结果和下次时间" 起={解析.起} 结果={解析.结果} 出错={解析.出错} />
                </div>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {还没挑 ? `先挑一位${b.customer}，AI 才认得出他的联系人和商机` : "解析结果只是预填，核对无误再保存"}
                </Typography.Text>
              )}
              {/* 跑着时不转圈：在做什么、过了几秒，左边那一行已经说了。按钮只负责「现在不能再点」 */}
              <Button size="small" type="primary" ghost icon={<ThunderboltOutlined />} disabled={aiLoading || 还没挑} onClick={onAiParse}>
                {解析?.结果 ? "重新解析" : "AI 解析填表"}
                <AiCost />
              </Button>
            </div>
          </div>
        )}
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name="type" label="跟进类型" rules={[{ required: true }]}>
              <Select options={FOLLOW_TYPES.map((t) => ({ value: t.value, label: t.label }))} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="status" label="状态">
              <Select options={FOLLOW_RECORD_STATUSES.map((s) => ({ value: s, label: s }))} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="occurredAt" label="发生时间" rules={[{ required: true }]}>
              <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
            </Form.Item>
          </Col>

          <Col span={24}>
            {/* 选填：时间线上已有跟进类型，标题只在需要一句话概括时才有意义 */}
            <Form.Item name="title" label="标题" extra="选填，填了会显示在跟进记录上">
              <Input placeholder="如：与周总沟通试单与报价" />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="content" label="沟通内容" rules={[{ required: true, message: "请填写沟通内容" }]}>
              <Input.TextArea rows={4} placeholder="记录沟通要点、客户反馈、下一步动作…" />
            </Form.Item>
          </Col>

          <Col span={12}>
            <Form.Item name="contactId" label="对接联系人">
              <Select
                allowClear
                placeholder="选择联系人"
                options={contacts.map((c) => ({
                  value: c.id,
                  label: c.position ? `${c.name}（${c.position}）` : c.name,
                }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="opportunityId" label={挂订单 ? "关联商机 / 订单" : "关联商机"}>
              <Select
                allowClear
                placeholder={挂订单 ? "选择商机或订单号" : "选择商机"}
                options={
                  (挂订单 && orders.length
                    ? [
                        { label: "订单", options: orders.map((o) => ({ value: `${订单前缀}${o.id}`, label: `订单 ${o.no}` })) },
                        { label: "商机", options: opportunities.map((o) => ({ value: o.id, label: o.name })) },
                      ]
                    : opportunities.map((o) => ({ value: o.id, label: o.name }))) as { value?: string; label: string; options?: { value: string; label: string }[] }[]
                }
              />
            </Form.Item>
          </Col>

          {showDuration && (
            <Col span={12}>
              <Form.Item name="durationMinutes" label="时长（分钟）">
                <InputNumber min={0} max={600} style={{ width: "100%" }} placeholder="如 18" />
              </Form.Item>
            </Col>
          )}
          {showDue && (
            <Col span={12}>
              <Form.Item
                name="dueAt"
                label={type === "TASK" ? "截止时间" : "提醒时间"}
                extra={record?.id ? undefined : "填了会同时加进待办，到点提醒"}
              >
                <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          )}
          {type === "MEETING" && (
            <Col span={12}>
              <Form.Item name="participants" label="参与人" tooltip="多人用逗号分隔">
                <Input placeholder="周总, 小李" />
              </Form.Item>
            </Col>
          )}
        </Row>
      </Form>

      {!record?.id && 收口计划 && (
        <div style={{ borderTop: "1px dashed var(--line-soft)", paddingTop: 12, marginTop: 4 }}>
          <Checkbox checked={收口} onChange={(e) => set收口(e.target.checked)}>
            同时完成计划「{收口计划.subject}」
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>（原定 {fmtDateTime(收口计划.plannedAt)}）</Typography.Text>
          </Checkbox>
        </div>
      )}

      {extras && !record?.id && (extras.tasks.length > 0 || extras.plan || suggestions.length > 0) && (
        <div style={{ borderTop: "1px dashed var(--line-soft)", paddingTop: 12, marginTop: 4 }}>
          <Space orientation="vertical" size={6} style={{ width: "100%" }}>
            {extras.tasks.map((t, i) => (
              <Checkbox
                key={i}
                checked={t.checked}
                onChange={(e) =>
                  setExtras({
                    ...extras,
                    tasks: extras.tasks.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)),
                  })
                }
              >
                同时创建待办：{t.title}
                {t.dueAt ? `（截止 ${fmtDateTime(t.dueAt)}）` : ""}
              </Checkbox>
            ))}
            {extras.plan && (
              <Checkbox
                checked={extras.plan.checked}
                onChange={(e) => setExtras({ ...extras, plan: { ...extras.plan!, checked: e.target.checked } })}
              >
                同时创建下次跟进计划：{extras.plan.subject} · {fmtDateTime(extras.plan.plannedAt)} · {extras.plan.method}
              </Checkbox>
            )}
            {suggestions.length > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                AI 建议：{suggestions.join("；")}（如认可，请到「编辑{b.customer}」里修改）
              </Typography.Text>
            )}
          </Space>
        </div>
      )}
    </Modal>
  );
}
