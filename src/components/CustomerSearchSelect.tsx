"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Select, type SelectProps } from "antd";
import { 搜客户, 取客户选项, type 可挑客户 } from "@/app/(app)/customers/[id]/pick";

type Props = Omit<SelectProps<string>, "options" | "showSearch" | "onSearch" | "filterOption" | "onChange"> & {
  initialOptions?: { id: string; name: string; label?: string }[];
  onChange?: (id?: string) => void;
};
/** 只在展开/搜索时读取有限候选；Form仍控制所选ID，不下载整张客户表。 */
export default function CustomerSearchSelect({ initialOptions = [], onChange, value, ...props }: Props) {
  const [rows, setRows] = useState<可挑客户[]>(() => initialOptions.map(row => ({ ...row, name: row.label ?? row.name, 附注: null })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const word = useRef("");
  function search(keyword: string) {
    const ticket = ++generation.current; word.current = keyword; setBusy(true); setError("");
    void 搜客户(keyword).then(result => {
      if (ticket !== generation.current) return;
      setRows(previous => {
        const selected = previous.find(row => row.id === value);
        return selected && !result.some(row => row.id === selected.id) ? [selected, ...result] : result;
      });
    }).catch(() => {
      if (ticket !== generation.current) return;
      setRows(previous => previous.filter(row => row.id === value)); setError("客户加载失败，请重试");
    }).finally(() => { if (ticket === generation.current) setBusy(false); });
  }
  useEffect(() => {
    if (!value || rows.some(row => row.id === value)) return;
    let active = true;
    void 取客户选项(value).then(row => {
      if (active && row) setRows(previous => previous.some(item => item.id === row.id) ? previous : [row, ...previous]);
    }).catch(() => { if (active) setError("所选客户加载失败，请重新搜索核对"); });
    return () => { active = false; };
  }, [value, rows]);
  useEffect(() => () => { generation.current++; if (timer.current) clearTimeout(timer.current); }, []);
  return <Select<string>
    {...props} value={value} onChange={onChange} loading={busy}
    onInputKeyDown={event => {
      props.onInputKeyDown?.(event);
      if (busy && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); }
    }}
    showSearch={{ filterOption: false, onSearch: keyword => {
      generation.current++; if (timer.current) clearTimeout(timer.current);
      // 防抖等待也属于搜索中；旧候选不能被快速回车或点击选中。
      setBusy(true);
      timer.current = setTimeout(() => search(keyword), 200);
    } }}
    onOpenChange={open => { if (open) search(""); props.onOpenChange?.(open); }}
    notFoundContent={busy ? "正在找…" : "没有匹配的客户，请换名字、公司或电话搜索"}
    options={rows.map(row => ({ value: row.id, label: [row.name, row.附注].filter(Boolean).join(" · "), disabled: busy }))}
    popupRender={menu => <>{menu}{error && <div role="alert" style={{ padding: 8 }}>{error}<Button type="link" size="small" onClick={() => search(word.current)}>重试</Button></div>}</>}
  />;
}
