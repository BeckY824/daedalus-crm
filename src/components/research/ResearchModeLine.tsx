"use client";

/**
 * 首页背调模式下输入框底下那行（10-16 用户：扣费说清在前面）：开始搜索后扣 1 次背调、还剩几次（10-18：没花钱不扣）；
 * 用完了 / 这台机器背调不了就说清楚（发送键同时是灰的，见 HomeChat 的 背调能发）。
 * 背调次数和问答的 AI 次数分开记，这一行只说背调的。
 */
import type { 背调价目 } from "@/lib/research/actions";

export default function ResearchModeLine({ 价 }: { 价: Awaited<ReturnType<typeof 背调价目>> | null }) {
  if (!价) return <span className="cli-quota">背调 · 正在查还剩几次…</span>;
  if (!价.可用) return <span className="cli-quota cli-quota-out">背调用不了：{价.原因}</span>;
  if (价.模拟) return <span className="cli-quota">背调 · 开发环境用模拟数据，不扣次数</span>;
  if (价.还剩 == null) return <span className="cli-quota">背调 · 开始搜索后扣 {价.扣次} 次 · 不限</span>;
  const 不够 = 价.还剩 < 价.扣次;
  return (
    <span className={`cli-quota${不够 ? " cli-quota-out" : 价.还剩 <= 2 ? " cli-quota-low" : ""}`} role="status">
      背调 · 开始搜索后扣 {价.扣次} 次 · 剩 {价.还剩} 次{不够 && `，还差 ${价.扣次 - 价.还剩} 次，需要加次数请联系我们`}
    </span>
  );
}
