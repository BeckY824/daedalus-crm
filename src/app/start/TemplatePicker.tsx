"use client";

import { 订单与供应商, 报价明细 } from "@/lib/features";
import { useState } from "react";
import { App } from "antd";
import type { BusinessTemplate } from "@/lib/business-config";
import { 选模版 } from "./actions";

/**
 * 两张卡二选一。说清楚选了以后**多了什么**，不只是叫法不同——外贸那张要让人一眼看到币种、报价、阶段叫法；
 * 订单和供应商这一版不上（lib/features.ts），卡上就不提，免得进去找不到；
 * 底下一句「以后能改」，免得人在这一步犹豫太久。
 */
const 卡: { t: BusinessTemplate; 名: string; 一句: string; 有: string[] }[] = [
  {
    t: "general",
    名: "通用销售",
    一句: "面向国内企业客户：线索、跟进、商机、签约一条线。",
    有: ["金额默认人民币，也能选其他币种", "客户来源：微信、小红书、抖音、转介绍…", "AI 帮你记跟进、盯谁该联系了"],
  },
  {
    t: "trade",
    名: "外贸出口",
    一句: "面向海外客户：询盘、报价、下单、出货。",
    有: [
      "金额默认美元，常用币种都能选",
      ...(报价明细 ? ["报价填单价和数量，看得到每次报的价"] : []),
      "阶段叫法换成询盘、比价中、已报价、寄样、客户确认",
      "客户来源换成阿里国际站、独立站询盘、展会这一套",
      ...(订单与供应商 ? ["订单按节点跟进：定金、生产、订舱、装柜、单据尾款", "一个询盘问几家供应商，比价留痕"] : []),
    ],
  },
];

export default function TemplatePicker() {
  const { message } = App.useApp();
  const [忙, set忙] = useState<BusinessTemplate | null>(null);

  async function 选(t: BusinessTemplate) {
    if (忙) return;
    set忙(t);
    const r = await 选模版(t);
    if (!r.ok) {
      set忙(null);
      message.error(r.error);
      return;
    }
    // 整页进主界面：从门口这一页进 (app) 的外壳，和登录成功那一跳同一个做法（login/after-login.ts）
    window.location.assign("/dashboard");
  }

  return (
    <div className="tpl">
      <h1 className="tpl-h">你主要做哪一类生意？</h1>
      <p className="tpl-s">选一个，界面和功能按它来。以后在「设置 → 业务配置」里随时能改。</p>
      <div className="tpl-cards">
        {卡.map((c) => (
          <button key={c.t} type="button" className={`tpl-card${忙 === c.t ? " on" : ""}`} onClick={() => void 选(c.t)} disabled={忙 !== null} aria-busy={忙 === c.t}>
            <b className="tpl-n">{c.名}</b>
            <span className="tpl-1">{c.一句}</span>
            <ul className="tpl-has">
              {c.有.map((x) => <li key={x}>{x}</li>)}
            </ul>
            <span className="tpl-go">{忙 === c.t ? "正在准备…" : `用${c.名}开始 →`}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
