"use client";

import { useState } from "react";
import { App, Alert, Button, Input, Typography } from "antd";
import { CheckOutlined } from "@ant-design/icons";
import { submitPayment } from "./actions";
import { PLANS, type PlanKey } from "@/lib/tenant/plans";
import { dayjs } from "@/lib/utils";

/**
 * 开通页：选套餐 → 转账 → 填单号 → 等我们开通。
 *
 * 没有在线支付的情况下，这一页要做的事只有一件：把「怎么付、付了之后会怎样」
 * 说到不用再问。含糊的付款说明是转化率杀手，比少一个支付方式严重得多。
 */
export default function BillingView({
  workspaceName,
  status,
  daysLeft,
  writable,
  isOwner,
  paidUntil,
}: {
  workspaceName: string;
  status: string;
  daysLeft: number;
  writable: boolean;
  isOwner: boolean;
  paidUntil: string | null;
}) {
  const { message } = App.useApp();
  const [plan, setPlan] = useState<PlanKey>("year");
  const [ref, setRef] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function submit() {
    if (ref.trim().length < 4) {
      message.error("请填写转账单号或付款截图里的流水号");
      return;
    }
    setSaving(true);
    const r = await submitPayment({ plan, reference: ref.trim() });
    setSaving(false);
    if (r.ok) {
      setDone(true);
      message.success("已收到，我们会在一个工作日内开通");
    } else message.error(r.error);
  }

  return (
    <div className="bill">
      <h1 className="bill-h">开通订阅</h1>
      <div className="bill-sub">
        工作区「{workspaceName}」
        {paidUntil ? ` · 已开通至 ${dayjs(paidUntil).format("YYYY-MM-DD")}` : writable ? ` · 试用还剩 ${daysLeft} 天` : " · 试用已结束"}
      </div>

      {!writable && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 18 }}
          title="现在是只读状态"
          description="已有数据可以继续查看和导出，新增与修改要在开通后恢复。数据一直在，不会因为过期被删。"
        />
      )}

      <div className="bill-plans">
        {(Object.keys(PLANS) as PlanKey[]).map((k) => (
          <button key={k} type="button" className={`bill-plan${plan === k ? " bill-plan-on" : ""}`} onClick={() => setPlan(k)}>
            <div className="bill-plan-h">
              {PLANS[k].label}
              {PLANS[k].badge && <span className="bill-plan-badge">{PLANS[k].badge}</span>}
            </div>
            <div className="bill-plan-price">
              ¥{PLANS[k].price}
              <span className="bill-plan-unit">/{PLANS[k].unit}</span>
            </div>
            <div className="bill-plan-note">{PLANS[k].note}</div>
          </button>
        ))}
      </div>

      {!isOwner ? (
        <Alert type="info" showIcon title="只有工作区创建者能开通" description="请让创建这个工作区的同事来这一页操作。" />
      ) : done ? (
        <Alert
          type="success"
          showIcon
          title="已收到你的付款信息"
          description="我们核对后会开通，通常在一个工作日内。开通后这一页会显示到期日期。"
        />
      ) : (
        <div className="bill-pay">
          <div className="bill-pay-h">怎么付</div>
          <ol className="bill-steps">
            <li>
              按上面选中的套餐转账：<Typography.Text strong>¥{PLANS[plan].price}</Typography.Text>
            </li>
            <li>
              对公账户或微信 / 支付宝转账，收款信息见
              <a href="mailto:hello@ai-daedalus.com"> hello@ai-daedalus.com</a> 或页面右下角联系我们
            </li>
            <li>把转账单号填在下面提交，我们核对后开通</li>
          </ol>
          <div className="bill-form">
            <Input
              placeholder="转账单号 / 流水号"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              maxLength={64}
              style={{ maxWidth: 320 }}
            />
            <Button type="primary" onClick={submit} loading={saving} icon={<CheckOutlined />}>
              我已付款
            </Button>
          </div>
          <div className="bill-tip">在线扫码支付正在接入，接好后这里会多一个二维码，无需再填单号。</div>
        </div>
      )}

      <div className="bill-faq">
        <div className="bill-faq-q">试用结束后数据会被删吗？</div>
        <div className="bill-faq-a">不会。数据一直留着，只是不能新增和修改。你也可以随时导出带走。</div>
        <div className="bill-faq-q">能开发票吗？</div>
        <div className="bill-faq-a">能。提交付款信息后把抬头和税号发给我们即可。</div>
        <div className="bill-faq-q">不想用托管版，能自己部署吗？</div>
        <div className="bill-faq-a">
          能，而且免费。整套系统是开源的，见
          <a href="https://github.com/BeckY824/daedalus-crm" target="_blank" rel="noreferrer">
            {" "}
            GitHub 仓库
          </a>
          。托管版卖的是省事，不是功能。
        </div>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 18 }}>当前状态：{status}</div>
    </div>
  );
}
