"use client";

import { useRef, useState } from "react";
import { AutoComplete, Button, Input, InputNumber } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { 金额 } from "@/lib/currency";
import { 常用单位, 报价行上限, 小计, 报价合计, 一行说法 } from "@/lib/quote";
import type { 一次报价 } from "@/lib/quote-db";
import { fmtDate } from "@/lib/utils";
import { 上次报价 } from "./actions";

/** 编辑中的一行。数量 / 单价可能还没填（null），和存进库的 报价行 分开 */
export type 草稿行 = { key: string; product: string; spec: string; qty: number | null; unit: string; unitPrice: number | null };

let 序 = 0;
export const 新行 = (r?: Partial<草稿行>): 草稿行 => ({ key: `q${++序}`, product: "", spec: "", qty: null, unit: "", unitPrice: null, ...r });

/** 草稿 → 交给 saveOpportunity 的样子（整行空着的服务端会丢掉） */
export const 交出去 = (行: 草稿行[]) =>
  行.map((r) => ({ product: r.product, spec: r.spec, qty: r.qty ?? 0, unit: r.unit, unitPrice: r.unitPrice ?? 0 }));

export const 草稿合计 = (行: 草稿行[]) => 报价合计(行.map((r) => ({ qty: r.qty ?? 0, unitPrice: r.unitPrice ?? 0 })));

type 提示 = Awaited<ReturnType<typeof 上次报价>>;

/**
 * 商机框里的「报价明细」（2026-10-03 外贸第 3 块）。
 *
 * 一行：产品、规格、数量、单位、单价，小计自己算。没有行的时候只是一个「＋ 加报价明细」，不占地方——
 * 不是每个商机都要拆到单价（少即是多）。
 * 产品名填完（失焦）去问一次「上次报这个客户这个产品多少」，有就在这一行下面说一句，点「用这个价」填进单价：
 * 外贸报价最常见的动作就是翻上回的邮件找价格。
 * 历次报价（以前的版本）在表下面折着，点开看每一版的日期、合计和明细。
 */
export default function QuoteLines({
  行,
  onChange,
  currency,
  customerId,
  opportunityId,
  历次,
}: {
  行: 草稿行[];
  onChange: (行: 草稿行[]) => void;
  currency: string;
  customerId?: string;
  opportunityId?: string;
  /** 这个商机以前报过的几版（新的在前，第一版就是现在表里这一版） */
  历次: 一次报价[];
}) {
  const [提示们, set提示们] = useState<Record<string, NonNullable<提示>>>({});
  const [看历次, set看历次] = useState(false);
  /** 问过的「客户 + 产品」不再问：失焦一次问一次库，来回点几下就是几趟 */
  const 问过 = useRef(new Map<string, 提示>());
  const 产品框 = useRef(new Map<string, HTMLInputElement | null>());

  const 改 = (key: string, patch: Partial<草稿行>) => onChange(行.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const 加一行 = () => {
    const r = 新行();
    onChange([...行, r]);
    // 加完光标进新行的产品框，人不用再伸手去点
    requestAnimationFrame(() => 产品框.current.get(r.key)?.focus());
  };

  async function 问上次(r: 草稿行) {
    if (!customerId || !r.product.trim()) return;
    const k = `${customerId}|${r.product.trim().toLowerCase()}`;
    let 答 = 问过.current.get(k);
    if (答 === undefined) {
      答 = await 上次报价(customerId, r.product, opportunityId).catch(() => null);
      问过.current.set(k, 答);
    }
    set提示们((m) => {
      const n = { ...m };
      if (答) n[r.key] = 答;
      else delete n[r.key];
      return n;
    });
  }

  const 以前的 = 历次.slice(1);

  if (行.length === 0) {
    return (
      <div className="qt">
        <Button type="link" size="small" icon={<PlusOutlined />} style={{ padding: 0 }} onClick={加一行}>
          加报价明细（产品、数量、单价）
        </Button>
        {历次.some((q) => q.行.length > 0) && <span className="qt-note">明细已清空，以前报过 {历次.filter((q) => q.行.length > 0).length} 次</span>}
      </div>
    );
  }

  return (
    <div className="qt">
      <div className="qt-row qt-head" aria-hidden>
        <span>产品</span>
        <span>规格</span>
        <span>数量</span>
        <span>单位</span>
        <span>单价</span>
        <span className="qt-num">小计</span>
        <span />
      </div>
      {行.map((r, i) => {
        const 示 = 提示们[r.key];
        return (
          <div key={r.key} className="qt-item">
            <div className="qt-row">
              <Input
                size="small"
                ref={(el) => { 产品框.current.set(r.key, el?.input ?? null); }}
                aria-label={`第 ${i + 1} 行产品`}
                placeholder="如 LED 面板灯"
                value={r.product}
                maxLength={120}
                onChange={(e) => 改(r.key, { product: e.target.value })}
                onBlur={() => void 问上次(r)}
              />
              <Input size="small" aria-label={`第 ${i + 1} 行规格`} placeholder="如 60×60 4000K" value={r.spec} maxLength={300} onChange={(e) => 改(r.key, { spec: e.target.value })} />
              <InputNumber<number> size="small" aria-label={`第 ${i + 1} 行数量`} min={0} value={r.qty} onChange={(v) => 改(r.key, { qty: v })} style={{ width: "100%" }} />
              <AutoComplete
                size="small"
                aria-label={`第 ${i + 1} 行单位`}
                value={r.unit}
                options={常用单位.map((u) => ({ value: u }))}
                filterOption={(input, o) => String(o?.value ?? "").toLowerCase().startsWith(input.toLowerCase())}
                onChange={(v: string) => 改(r.key, { unit: v.slice(0, 20) })}
                style={{ width: "100%" }}
              />
              <InputNumber<number> size="small" aria-label={`第 ${i + 1} 行单价`} min={0} value={r.unitPrice} onChange={(v) => 改(r.key, { unitPrice: v })} style={{ width: "100%" }} />
              <span className="qt-num" aria-label={`第 ${i + 1} 行小计`}>{金额(小计({ qty: r.qty ?? 0, unitPrice: r.unitPrice ?? 0 }), currency)}</span>
              <Button type="text" size="small" icon={<DeleteOutlined />} aria-label={`删掉第 ${i + 1} 行`} onClick={() => onChange(行.filter((x) => x.key !== r.key))} />
            </div>
            {示 && (
              <div className="qt-hint">
                上次报这个客户 {金额(示.unitPrice, 示.currency)}{示.unit ? ` / ${示.unit}` : ""}（{fmtDate(示.quotedAt)}，{示.商机}）
                {示.currency === currency && 示.unitPrice !== r.unitPrice && (
                  <button type="button" className="qt-use" onClick={() => 改(r.key, { unitPrice: 示.unitPrice, ...(r.unit ? {} : { unit: 示.unit ?? "" }) })}>
                    用这个价
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div className="qt-foot">
        <Button type="link" size="small" icon={<PlusOutlined />} style={{ padding: 0 }} onClick={加一行} disabled={行.length >= 报价行上限}>
          加一行
        </Button>
        <span>
          合计 <b>{金额(草稿合计(行), currency)}</b>
        </span>
      </div>
      {以前的.length > 0 && (
        <div className="qt-his">
          <button type="button" className="qt-use" onClick={() => set看历次(!看历次)} aria-expanded={看历次}>
            {看历次 ? "收起历次报价" : `以前报过 ${以前的.length} 次`}
          </button>
          {看历次 && (
            <ul>
              {以前的.map((q) => (
                <li key={q.id}>
                  <span className="qt-his-d">{fmtDate(q.quotedAt)}</span>
                  <b>{q.行.length ? 金额(q.合计, q.currency) : "清空了明细"}</b>
                  <span className="qt-his-l">{q.行.map(一行说法).join("；")}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
