"use client";

import { useEffect, useRef } from "react";
import { Input } from "antd";
import { SearchOutlined } from "@ant-design/icons";

/** 打字停多久就筛。短了每个字都跑一趟服务端，长了人会以为没反应 */
const 停顿 = 300;

/**
 * 列表页的搜索框：打字停一下就筛，回车立刻筛，点小叉立刻回到全部。
 *
 * 原来五张列表页各抄一份（图标、清空、回车），而且都得按回车才筛。2026-09-28 拿教程录制脚本重跑时发现：
 * 配音说「输入公司名，马上就筛出来」，录出来的画面却一直是全量——录的人和看的人都以为输进去就会筛。
 * 渠道页是一次拿全、在本地筛的，本来就即时，不用它。
 *
 * onSearch 拿的是最新那一版（放在 ref 里）：页面的筛选条件是它闭包里的 state，
 * 停顿期间人改了别的下拉，用旧闭包会把那一下改动冲掉。
 */
export default function ListSearch({
  value,
  onChange,
  onSearch,
  placeholder,
  width = 260,
}: {
  value: string;
  onChange: (v: string) => void;
  onSearch: (v: string) => void;
  placeholder: string;
  width?: number;
}) {
  const 计时 = useRef<ReturnType<typeof setTimeout>>(undefined);
  const 最新 = useRef(onSearch);
  useEffect(() => {
    最新.current = onSearch;
  });
  useEffect(() => () => clearTimeout(计时.current), []);

  const 现在筛 = (v: string) => {
    clearTimeout(计时.current);
    最新.current(v);
  };

  return (
    <Input
      style={{ width }}
      placeholder={placeholder}
      prefix={<SearchOutlined style={{ color: "var(--text-muted)" }} />}
      value={value}
      allowClear
      onChange={(e) => {
        const v = e.target.value;
        onChange(v);
        clearTimeout(计时.current);
        if (!v) 现在筛("");
        else 计时.current = setTimeout(() => 最新.current(v), 停顿);
      }}
      onPressEnter={() => 现在筛(value)}
    />
  );
}
