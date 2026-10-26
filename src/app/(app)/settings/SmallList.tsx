"use client";

import { useState } from "react";
import { Pagination } from "antd";

/**
 * 设置页里的小清单（同事删掉的客户、从备份捞回）：一行内容 + 右边一个按钮，超过 10 行分页。
 * 设置页不是列表页，不用表格组件（见 tests/one-table.test.ts）；antd 的 List 已弃用、开着会在控制台报警告，也不用。
 */
export default function SmallList<T>({ rows, rowKey, children, action }: { rows: T[]; rowKey: (r: T) => string; children: (r: T) => React.ReactNode; action: (r: T) => React.ReactNode }) {
  const [选的页, set页] = useState(1);
  const 每页 = 10;
  // 捞回 / 恢复后行变少，原来那页可能没了：退到最后一页
  const 页 = Math.min(选的页, Math.max(1, Math.ceil(rows.length / 每页)));
  const 这页 = rows.length > 每页 ? rows.slice((页 - 1) * 每页, 页 * 每页) : rows;
  return (
    <>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {这页.map((r) => (
          <li key={rowKey(r)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--line-soft)" }}>
            {children(r)}
            <span style={{ flex: "none" }}>{action(r)}</span>
          </li>
        ))}
      </ul>
      {rows.length > 每页 && <Pagination size="small" style={{ marginTop: 8, justifyContent: "flex-end" }} current={页} pageSize={每页} total={rows.length} onChange={set页} showSizeChanger={false} />}
    </>
  );
}
