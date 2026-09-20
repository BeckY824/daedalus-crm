"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { App, AutoComplete, DatePicker, Input, Select } from "antd";
import { dayjs } from "@/lib/utils";
import { patchCustomer, type PatchableKey } from "../actions";

type Option = { value: string; label: string };

/**
 * 记录页左栏的"点一下就能改"字段。
 * 平时是一行文字；点击变成输入框，失焦或回车即存，Esc 放弃。
 * 不弹窗、不用"保存"按钮——改一个字段本来就该是一个动作。
 */
export default function InlineField({
  customerId,
  field,
  label,
  value,
  kind = "text",
  options,
  placeholder = "点击填写",
}: {
  customerId: string;
  field: PatchableKey;
  label: string;
  value: string | null;
  /** combo = 能选也能填的下拉。给职位 / 年级那种「库里是自由文本、下拉只是建议」的字段 */
  kind?: "text" | "textarea" | "select" | "combo" | "date";
  options?: Option[];
  placeholder?: string;
}) {
  const router = useRouter();
  const { message } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(value);
  const [saving, setSaving] = useState(false);

  async function commit(next: string | null) {
    setEditing(false);
    const normalized = next?.trim() ? next.trim() : null;
    if ((normalized ?? null) === (value ?? null)) return;
    setSaving(true);
    const res = await patchCustomer(customerId, field, normalized);
    setSaving(false);
    if (!res.ok) {
      message.error(res.error);
      setDraft(value);
      return;
    }
    router.refresh();
  }

  const display =
    (kind === "select" || kind === "combo") && options
      ? (options.find((o) => o.value === value)?.label ?? value)
      : kind === "date" && value
        ? dayjs(value).format("YYYY-MM-DD")
        : value;

  if (!editing) {
    return (
      <div className="rec-field" onClick={() => setEditing(true)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setEditing(true)} aria-label={`编辑${label}`}>
        <div className="rec-field-k">{label}</div>
        <div className={`rec-field-v${display ? "" : " rec-field-empty"}${saving ? " rec-field-saving" : ""}`}>{display || placeholder}</div>
      </div>
    );
  }

  const common = { autoFocus: true, size: "middle" as const, style: { width: "100%" } };
  return (
    <div className="rec-field rec-field-editing">
      <div className="rec-field-k">{label}</div>
      {kind === "select" && (
        <Select
          {...common}
          defaultOpen
          value={draft ?? undefined}
          options={options}
          onChange={(v) => {
            setDraft(v);
            void commit(v);
          }}
          onBlur={() => setEditing(false)}
        />
      )}
      {kind === "combo" && (
        /*
          能选也能填。和上面那个 select 的区别只有一条：不在选项里的值也收。
          所以不能用 onChange 提交（打字的每一下都会触发），改成失焦 / 回车提交，
          和 text 那一支一个节奏。
        */
        <AutoComplete
          {...common}
          defaultOpen
          allowClear
          value={draft ?? undefined}
          options={options?.map((o) => ({ value: o.value }))}
          filterOption={(输入, o) => String(o?.value ?? "").toLowerCase().includes(输入.toLowerCase())}
          onChange={(v) => setDraft(v ?? "")}
          onBlur={() => void commit(draft ?? "")}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit(draft ?? "");
            if (e.key === "Escape") setEditing(false);
          }}
        />
      )}
      {kind === "date" && (
        <DatePicker
          {...common}
          open
          value={draft ? dayjs(draft) : null}
          onChange={(d) => {
            const v = d ? d.toDate().toISOString() : null;
            setDraft(v);
            void commit(v);
          }}
          onOpenChange={(o) => !o && setEditing(false)}
        />
      )}
      {kind === "textarea" && (
        <Input.TextArea
          {...common}
          autoSize={{ minRows: 2, maxRows: 8 }}
          value={draft ?? ""}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit(draft)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(value);
              setEditing(false);
            }
          }}
        />
      )}
      {kind === "text" && (
        <Input
          {...common}
          value={draft ?? ""}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit(draft)}
          onPressEnter={() => void commit(draft)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(value);
              setEditing(false);
            }
          }}
        />
      )}
    </div>
  );
}
