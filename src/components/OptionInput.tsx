"use client";

import { AutoComplete } from "antd";

/**
 * 能选也能填（2026-10-02 用户：「需要用户选择的，有些提供选项，能不能也让用户自己输入」）。
 *
 * 给候选，也收候选以外的字：来源、行业、跟进方式这类**没有程序按值去判断**的格子，
 * 人手上的说法千奇百怪（「视频号直播间」「老板朋友圈」），只让选等于逼他挑一个不对的。
 * 跟进状态、商机阶段这类会被盯盘、报表、赢单逻辑按值引用的，**不用**这个——那些仍是下拉。
 *
 * 一打字候选就按包含筛；清空 / 失焦都保留人打的字。Form.Item 直接包它即可（value / onChange）。
 */
export default function OptionInput({
  id,
  value,
  onChange,
  options,
  placeholder,
  allowClear = true,
  style,
  size,
  maxLength,
  "aria-label": ariaLabel,
}: {
  /** Form.Item 注入的 id：表单标签靠它和输入框关联（读屏、按标签找输入框都靠这个） */
  id?: string;
  "aria-label"?: string;
  value?: string | null;
  onChange?: (v: string) => void;
  options: readonly string[];
  placeholder?: string;
  allowClear?: boolean;
  style?: React.CSSProperties;
  size?: "small" | "middle" | "large";
  maxLength?: number;
}) {
  return (
    <AutoComplete
      id={id}
      aria-label={ariaLabel}
      value={value ?? undefined}
      onChange={(v) => {
        const s = String(v ?? "");
        onChange?.(maxLength ? s.slice(0, maxLength) : s);
      }}
      options={options.map((o) => ({ value: o }))}
      filterOption={(输入, o) => !输入 || String(o?.value ?? "").toLowerCase().includes(输入.toLowerCase())}
      placeholder={placeholder ?? "选一个，或直接填"}
      allowClear={allowClear}
      style={style}
      size={size}
    />
  );
}
