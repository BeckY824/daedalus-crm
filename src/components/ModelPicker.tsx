"use client";

import { useSyncExternalStore } from "react";
import { Dropdown } from "antd";
import { CheckOutlined, DownOutlined } from "@ant-design/icons";
import type { ModelOption } from "@/lib/llm";

/**
 * 首页的模型选单（照 Claude Code / Codex：输入框下面一个不起眼的小控件）。
 *
 * 选择只存在浏览器里，不进库：换模型是"我这次想用哪个"，不是团队配置。
 * 能选哪些由设置页的白名单决定，服务端每次还会再校验一遍——这里选中的值
 * 会随请求发上去，不能当成可信输入。
 * 存的是模型名而不是序号：管理员改了选单顺序，人选的还是原来那个模型。
 */
const KEY = "daedalus.model";
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function setModel(id: string) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // 无痕模式下存不了，就这一会儿有效
  }
  notify();
}

/** 当前选中的模型；没选过或选的已经不在单子里就用第一个（默认模型） */
export function useModel(options: ModelOption[]): string {
  const saved = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => "",
  );
  const fallback = options[0]?.id ?? "";
  return options.some((o) => o.id === saved) ? saved : fallback;
}

/** 模型名通常是 deepseek-v4.1-flash 这种，选单里直接显示原名，不自作主张美化 */
export default function ModelPicker({ options, value }: { options: ModelOption[]; value: string }) {
  if (options.length < 2) return null;
  return (
    <Dropdown
      trigger={["click"]}
      placement="topLeft"
      menu={{
        items: options.map((o) => ({
          key: o.id,
          label: (
            <span className="mp-row">
              <CheckOutlined style={{ opacity: o.id === value ? 1 : 0, fontSize: 11 }} />
              <span className="mp-id">{o.id}</span>
              {o.note && <span className="mp-note">{o.note}</span>}
            </span>
          ),
        })),
        onClick: ({ key }) => setModel(key),
      }}
    >
      <button type="button" className="mp-btn" aria-label={`模型：${value}`}>
        {value}
        <DownOutlined style={{ fontSize: 9 }} />
      </button>
    </Dropdown>
  );
}
