"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { App, Alert, Button, List, Tag, Typography } from "antd";
import { smartTime } from "@/lib/utils";
import { 读被盖掉, 看过被盖掉动作 } from "./team-actions";

type 条目 = Awaited<ReturnType<typeof 读被盖掉>>[number];

/**
 * 设置 → 团队 → 被同事盖掉的改动（2026-10-16 团队版全面检验 A 条，lib/sync/overwritten.ts）。
 * 两个人断网时（或几乎同时）改了同一格，按谁后改算，我这边写的悄悄变成了同事的：在这里把我原来写的摆出来，
 * 要的话点进去改回去。只提示、不回滚；「知道了」只是不再提示。
 */
export default function OverwrittenCard({ onChange }: { onChange?: () => void }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<条目[] | null>(null);
  useEffect(() => { let on = true; void 读被盖掉().then((r) => on && setRows(r)); return () => { on = false; }; }, []);
  if (!rows || rows.length === 0) return null;

  async function 知道了(ids: number[]) {
    await 看过被盖掉动作(ids);
    message.success("好的，不再提示这几处");
    setRows(await 读被盖掉());
    onChange?.();
  }
  const 值 = (v: string | null) => (v == null || v === "" ? <span className="muted">（空）</span> : <Typography.Text>「{v}」</Typography.Text>);
  return (
    <section className="team-card" data-testid="overwritten">
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message={`有 ${rows.length} 处你改的，被同事后来的改动盖掉了`}
        description="你们差不多同时（或者断网时）改了同一格，按谁后改算，现在是同事改的那个。你原来写的在下面，要的话点进去再改回来。" />
      {/* 设置页里的小清单，不是列表页：不用表格组件（见 tests/one-table.test.ts） */}
      <List<条目> size="small" dataSource={rows} pagination={rows.length > 10 ? { pageSize: 10 } : false}
        renderItem={(r) => (
          <List.Item actions={[<Button key="ok" size="small" type="text" onClick={() => void 知道了([r.id])}>知道了</Button>]}>
            <span style={{ flex: 1 }}>
              <Tag>{r.表}</Tag>
              {r.href ? <Link href={r.href}>{r.名称}</Link> : r.名称} · {r.列}：你写的 {值(r.我写的)}，现在是 {值(r.现在)}
            </span>
            <span className="muted">{smartTime(r.同事改的时间)}</span>
          </List.Item>
        )} />
      {rows.length > 1 && <Button size="small" style={{ marginTop: 8 }} onClick={() => void 知道了(rows.map((r) => r.id))}>都知道了</Button>}
    </section>
  );
}
