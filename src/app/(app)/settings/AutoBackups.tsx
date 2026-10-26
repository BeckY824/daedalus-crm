"use client";

import { useEffect, useState } from "react";
import { App, Button } from "antd";
import dayjs from "dayjs";
import BackupRescue from "./BackupRescue";
import { 读备份列表 } from "./team-actions";

/**
 * 设置 → 桌面端 →「本机数据」里那一列自动备份（2026-10-04，D-078 / J-242）。
 * 备份本身由壳在每次起本地服务前做（desktop/auto-backup.js）：每天第一次一份留 7 份、升级前一份留 3 份。
 * 这里只负责看得见、点得回：恢复前当前库会先另存一份「恢复前」，恢复错了还能再恢复回来。
 * 老版本的壳没有这两个口子，那时整块不出现。
 * 每天那份另有「只捞回删掉的客户」（2026-10-26，BackupRescue）：不整库恢复，只把那天有、现在没有的客户补回来。只给老板 / 业务主管 / 个人版。
 */
export type 自动备份项 = { 文件名: string; 类型: "每天" | "升级前" | "恢复前" | "合并前"; 时间: string; 大小: number };

const 说大小 = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
/** 升级前那份把版本号念出来：before-upgrade-0.46.14-to-0.46.15.db → 0.46.14 → 0.46.15 */
const 说升级 = (f: string) => f.match(/^before-upgrade-(.+)-to-(.+)\.db$/)?.slice(1, 3).join(" → ");

export default function AutoBackups() {
  const { modal, message } = App.useApp();
  const [列表, set列表] = useState<自动备份项[] | null>(null);
  const [有口子, set有口子] = useState(false);
  const [能捞, set能捞] = useState<Set<string>>(new Set());
  const [捞, set捞] = useState<{ 文件: string; 何时: string } | null>(null);

  useEffect(() => {
    const s = window.desktopShell;
    if (!s?.autoBackups) return;
    s.autoBackups()
      .then((x) => {
        set有口子(true);
        set列表(x);
      })
      .catch(() => set列表([]));
    void 读备份列表().then((x) => set能捞(new Set(x.map((b) => b.文件)))).catch(() => undefined);
  }, []);

  if (!有口子) return null;

  function 恢复(项: 自动备份项) {
    const 何时 = dayjs(项.时间).format("M 月 D 日 HH:mm");
    modal.confirm({
      title: `恢复到 ${何时} 的备份？`,
      content: "这之后录的会回到那时的样子。当前好库先另存「恢复前」；如已损坏，会保留原数据库及临时文件供进一步恢复。恢复时应用会重新载入几秒。",
      okText: "恢复",
      cancelText: "取消",
      async onOk() {
        const r = await window.desktopShell?.restoreAutoBackup?.(项.文件名).catch(() => ({ ok: false, error: "恢复请求失败，请检查应用日志后重试" }));
        // 成功时壳会整页重载，这一句多半来不及看见；失败才是要说清楚的
        if (r && !r.ok) message.error(r.error ?? "没恢复成");
      },
    });
  }

  return (
    <div className="auto-backups">
      <div className="auto-backups-h">自动备份</div>
      {!列表 ? null : 列表.length === 0 ? (
        <p className="auto-backups-empty">还没有。有了客户之后，每天第一次打开会自动备一份，留最近 7 天；升级前也会先备一份。</p>
      ) : (
        <ul className="auto-backups-list">
          {列表.map((项) => (
            <li key={项.文件名}>
              <span className="auto-backups-kind">{项.类型}</span>
              <span className="auto-backups-when">
                {dayjs(项.时间).format("M 月 D 日 HH:mm")}
                {项.类型 === "升级前" && 说升级(项.文件名) ? ` · ${说升级(项.文件名)}` : ""}
              </span>
              <span className="auto-backups-size">{说大小(项.大小)}</span>
              {能捞.has(项.文件名) && (
                <Button size="small" onClick={() => set捞({ 文件: 项.文件名, 何时: dayjs(项.时间).format("M 月 D 日") })}>
                  只捞回删掉的客户
                </Button>
              )}
              <Button size="small" onClick={() => 恢复(项)}>
                恢复
              </Button>
            </li>
          ))}
        </ul>
      )}
      {捞 && <BackupRescue 文件={捞.文件} 何时={捞.何时} onClose={() => set捞(null)} />}
    </div>
  );
}
