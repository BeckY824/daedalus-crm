"use client";

import { useMemo } from "react";
import { Select } from "antd";
import { 币种选项, 币种名 } from "@/lib/currency";

/**
 * 币种下拉（2026-10-03 全站币种）。和金额框并排用：`<Space.Compact>` 里左边它、右边 InputNumber。
 *
 * 「最近用过」排最前：外贸的人一般就常用两三种，每次从 25 种里找美元是折磨。
 * 记在本机浏览器（localStorage）——这是一个人的使用习惯，不是业务数据，丢了只是排序回到默认。
 * 选中后框里只显示代码（USD），下拉里写全（USD 美元），省地方。
 */
const 最近键 = "crm.recentCurrencies";

function 读最近(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(最近键) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function 记最近币种(码: string) {
  try {
    localStorage.setItem(最近键, JSON.stringify([码, ...读最近().filter((x) => x !== 码)].slice(0, 4)));
  } catch {
    // 存不下就算了：只影响排序
  }
}

export default function CurrencySelect({
  value,
  onChange,
  width = 96,
  disabled,
  ...rest
}: {
  value?: string;
  onChange?: (v: string) => void;
  width?: number;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  // 打开那一刻读一次就够；放 useMemo 里，SSR 时 localStorage 不在，退回默认排序
  const options = useMemo(() => 币种选项(typeof window === "undefined" ? [] : 读最近()), []);
  return (
    <Select
      value={value}
      onChange={(v: string) => {
        记最近币种(v);
        onChange?.(v);
      }}
      showSearch
      optionFilterProp="label"
      options={options}
      labelRender={(p) => <span title={币种名(String(p.value))}>{String(p.value)}</span>}
      popupMatchSelectWidth={200}
      style={{ width }}
      disabled={disabled}
      aria-label={rest["aria-label"] ?? "币种"}
    />
  );
}
