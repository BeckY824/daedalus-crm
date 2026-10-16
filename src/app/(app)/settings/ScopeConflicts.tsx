"use client";

import { useEffect, useState } from "react";
import { App, Alert, Button, Checkbox, List, Space, Tag } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { smartTime } from "@/lib/utils";
import { 读范围冲突, 导出范围冲突动作, 确认范围冲突动作 } from "./team-actions";
import { 冲突导出文件名 } from "./scope-conflicts-file";

type 条目 = Awaited<ReturnType<typeof 读范围冲突>>[number];

/**
 * 设置 → 团队 → 失权冲突（2026-10-13 范围同步）。
 * 记录在本机还有没上传的改动时被转走 / 移出公海：改动不丢，搬到这里。可以导出成文件给老板核对，
 * 「标记已处理」只是不再提醒，记录仍保留（导出里能看到），从不删除。
 */
export default function ScopeConflicts({ onChange }: { onChange?: () => void }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<条目[] | null>(null);
  const [选, set选] = useState<number[]>([]);
  const 刷 = async () => setRows(await 读范围冲突());
  useEffect(() => { let on = true; void 读范围冲突().then((r) => on && setRows(r)); return () => { on = false; }; }, []);
  if (!rows || rows.length === 0) return null;

  async function 导出() {
    const text = await 导出范围冲突动作();
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = 冲突导出文件名(new Date()); a.click();
    URL.revokeObjectURL(url);
  }
  async function 确认(ids: number[]) {
    const r = await 确认范围冲突动作(ids);
    message.success(`已标记 ${r.确认} 条为已处理（记录仍保留，可再导出）`);
    set选([]); await 刷(); onChange?.();
  }
  return (
    <section className="team-card" data-testid="scope-conflicts">
      <Alert type="warning" showIcon style={{ marginBottom: 12 }}
        message={`有 ${rows.length} 条改动因同步权限变化没能上传`}
        description="这些记录已经转给别人或不在你的同步范围内，你在这台电脑上的改动没有丢，也没有发出去。请导出发给老板核对，处理后再标记。" />
      <Space style={{ marginBottom: 8 }}>
        <Button icon={<DownloadOutlined />} onClick={() => void 导出()}>导出文件</Button>
        <Button disabled={!选.length} onClick={() => void 确认(选)}>标记所选为已处理</Button>
      </Space>
      {/* 设置页里的小清单，不是列表页：不用表格组件（见 tests/one-table.test.ts） */}
      <List<条目> size="small" dataSource={rows} pagination={rows.length > 10 ? { pageSize: 10 } : false}
        renderItem={(r) => (
          <List.Item>
            <Checkbox aria-label={`选择 ${r.名称}`} checked={选.includes(r.id)} onChange={(e) => set选(e.target.checked ? [...选, r.id] : 选.filter((x) => x !== r.id))} style={{ marginRight: 8 }} />
            {/* 名称和编号一样 = 这条已经不在这台电脑上、名字不留（防止转走的客户资料留在这里），别把一串编号摆给人看 */}
            <span style={{ flex: 1 }}><Tag>{r.表}</Tag>{r.名称 === r.编号 ? <span className="muted">（已转走，名字不显示）</span> : r.名称} · {r.操作}：{r.改动列.join("、")}</span>
            <span className="muted">{smartTime(r.改动时间)}</span>
          </List.Item>
        )} />
    </section>
  );
}
