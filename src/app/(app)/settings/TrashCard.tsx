"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { App, Alert, Button, Popconfirm, Tag, Typography } from "antd";
import { smartTime } from "@/lib/utils";
import SmallList from "./SmallList";
import { 读同步删掉的, 恢复同步删掉的动作 } from "./team-actions";

type 数据 = Awaited<ReturnType<typeof 读同步删掉的>>;
type 条目 = 数据["条目"][number];

/**
 * 设置 → 团队 → 同步删掉的客户（2026-10-26，lib/sync/trash.ts）。
 * 同事删了客户（离职前删、误删、恶意删），同步过来老板这台也跟着删了：删之前在老板这台留了一份，30 天内能放回去。
 * 按「谁删的」分组，一位一位恢复，或者把一个人删的一次全恢复。只插回本机现在没有的，老板自己的数据不动；放回去的推出去全队都有。
 * 只有老板那台（建团队的那台）有留底，别的电脑上这一栏不出现。
 */
export default function TrashCard({ onChange }: { onChange?: () => void }) {
  const { message } = App.useApp();
  const [d, setD] = useState<数据 | null>(null);
  const [忙, set忙] = useState<string | null>(null);
  useEffect(() => { let on = true; void 读同步删掉的().then((r) => on && setD(r)); return () => { on = false; }; }, []);
  if (!d || d.条目.length === 0) return null;

  const 名字 = new Map(d.人们.map((p) => [p.id, p.name]));
  const 组们 = new Map<string, 条目[]>();
  for (const x of d.条目) 组们.set(x.删的人 ?? "", [...(组们.get(x.删的人 ?? "") ?? []), x]);

  async function 恢复(键: string, roots: string[]) {
    set忙(键);
    try {
      const r = await 恢复同步删掉的动作(roots);
      if (!r.ok) { message.error(r.error); return; }
      message.success(r.插回 > 0 ? `放回去了 ${r.客户们.length} 位客户（${r.插回} 条），同步后同事那边也会有` : "这几位本机已经有了，没有要放回去的");
      setD(await 读同步删掉的());
      onChange?.();
    } finally {
      set忙(null);
    }
  }
  return (
    <section className="team-card" data-testid="sync-trash">
      <Alert type="warning" showIcon style={{ marginBottom: 12 }}
        message={`同事删掉的客户：${d.条目.length} 位（留 30 天）`}
        description="同事在他那台删了客户，同步过来这台也跟着删了。删之前这台留了一份（连同联系人、跟进、商机、签约），可以放回去：只补回现在没有的，你这两天自己录的不受影响；放回去的会同步给全队。不想让业务员删客户，可以在「业务配置」里关掉「业务员能删客户」。" />
      {[...组们].map(([人, rows]) => {
        const 叫 = 人 ? 名字.get(人) ?? "已经不在团队的同事" : "认不出是谁";
        const 猜的 = rows.every((r) => r.按负责人猜的);
        return (
          <div key={人 || "-"} style={{ marginBottom: 12 }} data-testid="sync-trash-group">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
              <Typography.Text strong style={{ minWidth: 0, overflowWrap: "anywhere" }}>{叫}{猜的 ? "（按客户原来的负责人认的）" : ""}</Typography.Text>
              <span className="muted">删了 {rows.length} 位</span>
              {rows.length > 1 && (
                <Popconfirm title={`把${叫}删的 ${rows.length} 位都放回去？`} okText="都放回去" cancelText="取消" onConfirm={() => 恢复(`p:${人}`, rows.map((r) => r.root))}>
                  <Button size="small" loading={忙 === `p:${人}`} disabled={!!忙 && 忙 !== `p:${人}`}>都恢复</Button>
                </Popconfirm>
              )}
            </div>
            <SmallList rows={rows} rowKey={(r) => r.root}
              action={(r) => <Button size="small" type="link" loading={忙 === r.root} disabled={!!忙 && 忙 !== r.root} onClick={() => void 恢复(r.root, [r.root])}>恢复</Button>}>
              {(r) => (
                <>
                  <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                    {r.客户还在 ? <Link href={`/customers/${r.root}`}>{r.名称}</Link> : r.名称}
                    {!r.客户也删了 && <Tag style={{ marginInlineStart: 6 }}>只删了下面几条</Tag>}
                    <span className="muted"> · {r.条数} 条</span>
                  </span>
                  <span className="muted" style={{ whiteSpace: "nowrap" }}>{smartTime(r.删的时间)}</span>
                </>
              )}
            </SmallList>
          </div>
        );
      })}
    </section>
  );
}
