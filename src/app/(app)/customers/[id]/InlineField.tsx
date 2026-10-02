"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { App, AutoComplete, DatePicker, Input, Select } from "antd";
import { dayjs } from "@/lib/utils";
import { patchCustomer, type PatchableKey } from "../actions";
import { 带走说法 } from "@/lib/carry-over";
import Shortcut from "@/components/Shortcut";

type Option = { value: string; label: string };

/**
 * 记录页左栏的"点一下就能改"字段。
 * 平时是一行文字；点击变成输入框，失焦或回车即存，Esc 放弃。
 * 不弹窗、不用"保存"按钮——改一个字段本来就该是一个动作。
 *
 * Esc 一律**还原并收起**（审查 D4）：原来「能选也能填」那一类按 Esc 不还原草稿，
 * 下次点开看到的是上次没存的字；而且输入框一收起，浏览器补发的那次失焦会拿着旧草稿去存——
 * 所以放弃用一个 ref 记着，commit 看见它就什么都不做。每次点开也从当前值起步。
 * 多行的「备注」回车是换行，⌘↵ 才存（框下面有一行淡字说）。
 */
export default function InlineField({
  customerId,
  field,
  label,
  value,
  kind = "text",
  options,
  placeholder = "点击填写",
  可清空 = false,
}: {
  customerId: string;
  field: PatchableKey;
  label: string;
  value: string | null;
  /** combo = 能选也能填的下拉。给职位 / 年级那种「库里是自由文本、下拉只是建议」的字段 */
  kind?: "text" | "textarea" | "select" | "combo" | "date";
  options?: Option[];
  placeholder?: string;
  /**
   * 下拉能清空（排查 D8）。渠道负责人那一格说明里写着「清空即恢复按推荐链」，原来下拉却没有清空的叉，
   * 一旦手工指定过就回不去了
   */
  可清空?: boolean;
}) {
  const router = useRouter();
  const { message } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(value);
  const [saving, setSaving] = useState(false);
  /** 这一次编辑是不是按 Esc 放弃了。放弃之后的失焦不许存 */
  const 放弃了 = useRef(false);

  function 开始() {
    放弃了.current = false;
    setDraft(value);
    setEditing(true);
  }
  function 放弃() {
    放弃了.current = true;
    setDraft(value);
    setEditing(false);
  }

  async function commit(next: string | null) {
    if (放弃了.current) return;
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
    // 换了销售负责人，原负责人没做完的活一起转过去了：说一声，不然人不知道计划和待办换了主（排查 B3）
    const 带走 = 带走说法(res.带走);
    if (带走) message.success(`已转给新负责人${带走}`);
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
      <div className="rec-field" onClick={开始} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && 开始()} aria-label={`编辑${label}`}>
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
          allowClear={可清空}
          onChange={(v) => {
            setDraft(v ?? null);
            void commit(v ?? null);
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
            if (e.key === "Escape") 放弃();
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
        <div>
          <Input.TextArea
            {...common}
            autoSize={{ minRows: 2, maxRows: 8 }}
            value={draft ?? ""}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit(draft)}
            onKeyDown={(e) => {
              if (e.key === "Escape") 放弃();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void commit(draft);
              }
            }}
          />
          <div className="rec-field-hint"><Shortcut>⌘↵</Shortcut> 保存 · Esc 放弃</div>
        </div>
      )}
      {kind === "text" && (
        <Input
          {...common}
          value={draft ?? ""}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit(draft)}
          onPressEnter={() => void commit(draft)}
          onKeyDown={(e) => {
            if (e.key === "Escape") 放弃();
          }}
        />
      )}
    </div>
  );
}
