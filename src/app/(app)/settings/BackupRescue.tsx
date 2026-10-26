"use client";

import { useEffect, useState } from "react";
import { App, Alert, Button, Modal, Popconfirm, Typography } from "antd";
import { smartTime } from "@/lib/utils";
import SmallList from "./SmallList";
import { 读备份里删了的, 从备份捞回动作 } from "./team-actions";

type 结果 = Awaited<ReturnType<typeof 读备份里删了的>>;
type 数据 = Extract<结果, { ok: true }>;
type 条目 = 数据["条目"][number];

/**
 * 设置 → 桌面端 → 自动备份 → 每天那份的「只捞回删掉的客户」（2026-10-26，lib/sync/trash-backup.ts）。
 * 同事删了客户、回收站没留到（更早删的、过了 30 天的），以前只能整库恢复那天的备份，这两天自己录的就没了。
 * 这里列出「那天的备份里有、现在没有」的客户，按谁删的分组，一位一位捞回，或者把一个人删的一次全捞回：
 * 只插回现在没有的，别的数据不动；捞回的同步给全队。
 */
export default function BackupRescue({ 文件, 何时, onClose }: { 文件: string; 何时: string; onClose: () => void }) {
  const { message } = App.useApp();
  const [d, setD] = useState<结果 | null>(null);
  const [忙, set忙] = useState<string | null>(null);
  useEffect(() => { let on = true; void 读备份里删了的(文件).then((r) => on && setD(r)); return () => { on = false; }; }, [文件]);

  async function 捞(键: string, ids: string[]) {
    set忙(键);
    try {
      const r = await 从备份捞回动作(文件, ids);
      if (!r.ok) { message.error(r.error); return; }
      message.success(r.插回 > 0 ? `捞回了 ${r.客户们.length} 位客户（${r.插回} 条），在团队里的话同步后同事那边也会有` : "这几位现在已经有了，没有要捞回的");
      setD(await 读备份里删了的(文件));
    } finally {
      set忙(null);
    }
  }

  let 内容: React.ReactNode = <p className="muted">正在读这份备份……</p>;
  if (d && !d.ok) 内容 = <Alert type="error" showIcon message={d.error} />;
  else if (d && d.条目.length === 0) 内容 = <p className="muted">这份备份里的客户现在都在，没有被删掉的。</p>;
  else if (d && d.ok) {
    const 名字 = new Map(d.人们.map((p) => [p.id, p.name]));
    const 组们 = new Map<string, 条目[]>();
    for (const x of d.条目) 组们.set(x.删的人 ?? "", [...(组们.get(x.删的人 ?? "") ?? []), x]);
    内容 = [...组们].map(([人, rows]) => {
      const 叫 = 人 ? 名字.get(人) ?? "已经不在团队的同事" : "认不出是谁";
      const 猜的 = rows.every((r) => r.按负责人猜的);
      return (
        <div key={人 || "-"} style={{ marginBottom: 12 }} data-testid="backup-rescue-group">
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <Typography.Text strong style={{ minWidth: 0, overflowWrap: "anywhere" }}>{叫}{猜的 ? "（按客户原来的负责人认的）" : ""}</Typography.Text>
            <span className="muted">{rows.length} 位</span>
            {rows.length > 1 && (
              <Popconfirm title={`把这 ${rows.length} 位都捞回来？`} okText="都捞回" cancelText="取消" onConfirm={() => 捞(`p:${人}`, rows.map((r) => r.id))}>
                <Button size="small" loading={忙 === `p:${人}`} disabled={!!忙 && 忙 !== `p:${人}`}>都捞回</Button>
              </Popconfirm>
            )}
          </div>
          <SmallList rows={rows} rowKey={(r) => r.id}
            action={(r) => <Button size="small" type="link" loading={忙 === r.id} disabled={!!忙 && 忙 !== r.id} onClick={() => void 捞(r.id, [r.id])}>捞回</Button>}>
            {(r) => (
              <>
                <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                  {r.名称}<span className="muted"> · 下面 {r.条数} 条</span>
                </span>
                {r.删的时间 && <span className="muted" style={{ whiteSpace: "nowrap" }}>{smartTime(r.删的时间)}删的</span>}
              </>
            )}
          </SmallList>
        </div>
      );
    });
  }

  return (
    <Modal open title={`从 ${何时} 的备份里只捞回删掉的客户`} onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>} width={640} destroyOnHidden>
      <p className="muted" style={{ marginTop: 0 }}>下面是那天的备份里有、现在没有的客户（合并掉的不算）。捞回只补现在没有的，你这两天录的、改的都不动；连同联系人、跟进、商机、签约和附件一起回来。</p>
      <div data-testid="backup-rescue">{内容}</div>
    </Modal>
  );
}
