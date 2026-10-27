"use client";

import DatePicker from "@/components/BusinessDatePicker";
import { useState } from "react";
import { Modal, Input, Select, Segmented, Button, Space, App, Typography } from "antd";
import type { Dayjs } from "dayjs";
import { dayjs } from "@/lib/utils";
import { 跟进类型表, 跟进类型名, 跟进类型值, 非渠道, type FollowTypeConfig } from "@/lib/follow-types";
import { useBusiness } from "@/lib/business-client";
import { 外贸精简 } from "@/lib/business-config";
import { hasVisibleText } from "@/lib/form-validation";
import { saveFollowUp, 撤销记一笔 } from "./actions";
import { 聚焦首项 } from "@/lib/modal-focus";
import { useFormGuard } from "@/lib/form-guard";

/**
 * 完成一条跟进计划时弹的小框（2026-10-16 外贸基础，总控：「方式 + 一句话 + 下次时间（默认 7 天后），保留『跳过，直接完成』。不做节奏标签」）。
 *
 * 外贸最常见的一串动作是「做完 → 记一下 → 排下次」。原来点完成只弹「撤销 / 排下一次」，跟进要另开表单记，
 * 多半就没记；下一次什么时候也常常没排。现在三件事一个框做完：
 *   保存并完成 = 记一条已完成的跟进 + 完成这条计划 + （选了的话）排下一次，一个事务（saveFollowUp 的「附带」）
 *   跳过，直接完成 = 交回页面，和原来一样只把计划勾掉
 * 手机上「记一笔」那张面板是同一个样子（app/m/MobileApp.tsx RecordSheet）：下次的主题、方式也照它的规矩取。
 */

export type 要完成的计划 = {
  id: string; subject: string; method: string; customerId: string; customerName?: string;
  /** 档案里填了 WhatsApp 号（2026-10-17 PR26 手测）：方式默认 WhatsApp，见 默认完成类型 */
  有WhatsApp?: boolean;
};

/**
 * 计划上写的方式 → 跟进类型。对不上的：外贸当 WhatsApp，别的当电话。
 * 先按名字认（含自定义渠道、改过的名）；按关键词猜出来的要是被藏了，换成下拉里第一个能选的渠道
 */
export function 方式到类型(method: string | null | undefined, 外贸: boolean, 渠道?: FollowTypeConfig | null): string {
  const m = String(method ?? "").trim();
  const 按名 = 跟进类型值(渠道, m);
  if (按名 && !非渠道.has(按名)) return 按名;
  const 猜 = 按关键词(m, 外贸);
  const 能选 = 跟进类型表(渠道, 外贸, { 只渠道: true });
  return 能选.some((t) => t.value === 猜) ? 猜 : (能选[0]?.value ?? 猜);
}
function 按关键词(m: string, 外贸: boolean): string {
  if (/whats\s*app/i.test(m)) return "WHATSAPP";
  if (/微信/.test(m)) return "WECHAT"; // 企业微信也算（2026-10-19 加微信沟通）
  if (/短信|消息/.test(m)) return "SMS";
  if (/邮件|mail/i.test(m)) return "EMAIL";
  if (/电话|call/i.test(m)) return "PHONE";
  if (/会议|视频|zoom|teams/i.test(m)) return "MEETING";
  if (/拜访|见面|上门/.test(m)) return "VISIT";
  return 外贸 ? "WHATSAPP" : "PHONE";
}

/**
 * 小框打开时「方式」那一格（2026-10-17 PR26 手测：电脑上有 WhatsApp 号的客户也该默认 WhatsApp，和手机上一样）。
 * 计划上的方式空着、或者是「电话沟通」——那是建计划时的老默认，多半没人挑过——而客户有 WhatsApp 号：WhatsApp。
 * 计划上明明白白写了别的（邮件、拜访……）照它的
 */
export function 默认完成类型(method: string | null | undefined, 外贸: boolean, 有WhatsApp = false, 渠道?: FollowTypeConfig | null): string {
  const m = String(method ?? "").trim();
  if (有WhatsApp && (!m || m === "电话沟通")) return 方式到类型("WhatsApp", 外贸, 渠道);
  return 方式到类型(m, 外贸, 渠道);
}

/** 下次那条计划的主题：和手机上一样，取这次那句话的第一句 */
export function 下次主题(内容: string): string {
  const 首句 = 内容.trim().split(/[，。！？,.!?\n]/)[0].slice(0, 20);
  return 首句 ? `接着跟进：${首句}` : "接着跟进";
}

type 下次 = "none" | "3" | "7" | "pick";

export type 记完了 = { kind: "saved"; next: string | null; 跟进id: string; 下次计划id: string | null };

/**
 * 「保存并完成」之后的提示，带「撤销」（2026-10-17 PR26 手测：「跳过，直接完成」有撤销，这边没有，
 * 点错了只能去时间线删跟进、计划页删计划）。撤销 = 删掉刚记的那笔和刚排的下一条、计划回到待办（撤销记一笔）。
 * 记录页和计划页共用；撤销成了由页面自己刷新
 */
export function 提示记完了(
  message: ReturnType<typeof App.useApp>["message"],
  plan: Pick<要完成的计划, "id" | "subject" | "customerId">,
  r: 记完了,
  撤销完了: () => void,
) {
  const key = `plan-saved-${plan.id}`;
  message.success({
    key,
    duration: 6,
    content: (
      <span>
        {r.next ? `已记一笔，「${plan.subject}」完成；下次 ${dayjs(r.next).format("M 月 D 日")}` : `已记一笔，「${plan.subject}」完成`}
        <Button
          type="link"
          size="small"
          onClick={async () => {
            message.destroy(key);
            const u = await 撤销记一笔({ customerId: plan.customerId, 跟进id: r.跟进id, 计划id: plan.id, 下次计划id: r.下次计划id })
              .catch(() => ({ ok: false as const, error: "没撤销成，请稍后重试" }));
            if (!u.ok) return void message.error(u.error);
            message.success(`「${plan.subject}」已改回未完成，刚记的那笔已删掉`);
            撤销完了();
          }}
        >
          撤销
        </Button>
      </span>
    ),
  });
}

type 框参数 = {
  /** 有值就开着 */
  plan: 要完成的计划 | null;
  onClose: () => void;
  /**
   * saved = 记了一笔、计划已在服务端一起完成（next 是排的下一次，YYYY-MM-DD，没排为 null；
   *   跟进id / 下次计划id 给提示条上的「撤销」用，见 提示记完了）；
   * skip = 人点了「跳过，直接完成」，由页面走原来那一下完成（计划页先原地打勾再存，留位不变）
   */
  onDone: (r: 记完了 | { kind: "skip" }) => void;
};

/** 每换一条计划整个框重新挂一次（key = 计划 id），框里的格子从这条计划的方式起头，不带上一条的残留 */
export default function CompletePlanModal(p: 框参数) {
  return p.plan ? <CompletePlanDialog key={p.plan.id} {...p} plan={p.plan} /> : null;
}

function CompletePlanDialog({ plan, onClose, onDone }: 框参数 & { plan: 要完成的计划 }) {
  const b = useBusiness();
  const 外贸 = 外贸精简(b);
  const { message } = App.useApp();
  const [类型, set类型] = useState(() => 默认完成类型(plan.method, 外贸, plan.有WhatsApp, b.followTypes));
  const [字, set字] = useState("");
  const [下次, set下次] = useState<下次>("7");
  const [日子, set日子] = useState<Dayjs | null>(() => dayjs().add(7, "day"));
  const [忙, set忙] = useState(false);
  // 点外面不关；写了那一句再按 Esc / X 先问一句（2026-10-19 客户反馈，lib/form-guard.tsx）。挂着一条计划，不算新建弹窗，不存草稿
  const 守 = useFormGuard({ open: true, 关: onClose, 填过: () => hasVisibleText(字), 忙, afterOpenChange: 聚焦首项 });

  const 下次日 = 下次 === "none" ? null : 下次 === "pick" ? 日子?.format("YYYY-MM-DD") ?? null : dayjs().add(Number(下次), "day").format("YYYY-MM-DD");
  const 可存 = hasVisibleText(字) && (下次 !== "pick" || !!日子);

  async function 保存() {
    if (忙 || !可存) return;
    set忙(true);
    try {
      const 内容 = 字.trim();
      const r = await saveFollowUp({
        customerId: plan.customerId,
        type: 类型,
        title: "",
        content: 内容,
        status: "已完成",
        occurredAt: new Date().toISOString(),
        附带: {
          tasks: [],
          ...(下次日 ? { plan: { subject: 下次主题(内容), plannedAt: 下次日, method: 跟进类型名(b.followTypes, 类型) } } : {}),
          完成计划: plan.id,
        },
      }).catch(() => ({ ok: false as const, error: "没保存上，请稍后重试" }));
      if (!r.ok) return void message.error("error" in r ? r.error : "没保存上，请稍后重试");
      onDone({ kind: "saved", next: 下次日, 跟进id: r.id, 下次计划id: r.下次计划id ?? null });
    } finally {
      set忙(false);
    }
  }

  function 跳过() {
    if (忙) return;
    onDone({ kind: "skip" });
  }

  return (
    <Modal
      open
      title="完成这条计划"
      {...守.弹窗}
      destroyOnHidden
      width={480}
      footer={
        <Space>
          <Button onClick={跳过} disabled={忙}>
            跳过，直接完成
          </Button>
          <Button type="primary" onClick={() => void 保存()} loading={忙} disabled={!可存}>
            保存并完成
          </Button>
        </Space>
      }
    >
      {(
        <div className="done-plan" data-testid="complete-plan-modal">
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            {plan.customerName ? `${plan.customerName} · ` : ""}「{plan.subject}」做完了，顺手记一笔。
          </Typography.Paragraph>
          <div className="done-plan-row">
            <span className="done-plan-k">方式</span>
            <Select
              aria-label="跟进方式"
              style={{ width: 180 }}
              value={类型}
              onChange={set类型}
              options={跟进类型表(b.followTypes, 外贸, { 只渠道: true }).map((t) => ({ value: t.value, label: t.label }))}
            />
          </div>
          <div className="done-plan-row">
            <span className="done-plan-k">一句话</span>
            <Input.TextArea
              aria-label="这次聊了什么"
              autoSize={{ minRows: 2, maxRows: 5 }}
              maxLength={2000}
              value={字}
              onChange={(e) => set字(e.target.value)}
              onPressEnter={(e) => { if (e.metaKey || e.ctrlKey) void 保存(); }}
              placeholder="聊了什么、结果怎样，比如：客户要了新报价，下周回"
            />
          </div>
          <div className="done-plan-row">
            <span className="done-plan-k">下次</span>
            <Space wrap size={8}>
              <Segmented<下次>
                aria-label="下次跟进"
                value={下次}
                onChange={set下次}
                options={[{ value: "none", label: "不排" }, { value: "3", label: "3 天后" }, { value: "7", label: "7 天后" }, { value: "pick", label: "选日子" }]}
              />
              {下次 === "pick" && (
                <DatePicker
                  aria-label="下次跟进日期"
                  value={日子}
                  onChange={(d) => set日子(d)}
                  disabledDate={(d) => d.isBefore(dayjs().startOf("day"))}
                  allowClear={false}
                />
              )}
            </Space>
          </div>
          {下次日 && <div className="done-plan-tip">{`会排一条 ${dayjs(下次日).format("M 月 D 日")}的计划：${下次主题(字)}`}</div>}
        </div>
      )}
    </Modal>
  );
}
