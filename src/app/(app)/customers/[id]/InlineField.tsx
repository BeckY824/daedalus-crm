"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input, Select, DatePicker, App } from "antd";
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
  kind?: "text" | "textarea" | "select" | "date";
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
    kind === "select" && options ? (options.find((o) => o.value === value)?.label ?? value) : kind === "date" && value ? dayjs(value).format("YYYY-MM-DD") : value;

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
