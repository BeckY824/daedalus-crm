"use client";

import { useState } from "react";
import { App, Button, Table, Tag } from "antd";
import { dayjs } from "@/lib/utils";
import { 页头 } from "../OpsShell";
import { 卡片 } from "../ui";
import { setSyncTeam } from "../actions";

type 行 = {
  id: string; name: string; active: boolean; createdAt: string; activatedAt: string | null;
  人数: number; 批次: number; 字节: number; 建的人: { name: string; email: string | null; phone: string | null } | null;
};

const 大小 = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b > 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);

/**
 * 团队同步（2026-10-03）。新团队「待开通」：建好、人拉齐了，这里点开通才开始收推送。
 * 我们只看得到这些元数据——密文打不开，钥匙在他们自己电脑上。
 */
export default function SyncView({ token, rows }: { token: string; rows: 行[] }) {
  const { message } = App.useApp();
  const [忙, set忙] = useState<string | null>(null);
  async function 切(r: 行) {
    set忙(r.id);
    const res = await setSyncTeam({ token, teamId: r.id, on: !r.active });
    set忙(null);
    if (res.ok) message.success(r.active ? "已停用" : "已开通");
    else message.error(res.error ?? "操作失败");
  }
  return (
    <>
      <页头 标题="团队同步" 说明={`${rows.length} 个团队 · 待开通 ${rows.filter((r) => !r.active).length}`} />
      <卡片 平>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={rows}
          locale={{ emptyText: "还没有人建团队" }}
          columns={[
            { title: "团队", dataIndex: "name", key: "n" },
            { title: "建的人", key: "o", render: (_, r) => (r.建的人 ? `${r.建的人.name} · ${r.建的人.email ?? r.建的人.phone ?? ""}` : "—") },
            { title: "人数", dataIndex: "人数", key: "p", width: 70 },
            { title: "批次", dataIndex: "批次", key: "b", width: 80 },
            { title: "占用", key: "s", width: 90, render: (_, r) => 大小(r.字节) },
            { title: "建于", key: "c", width: 110, render: (_, r) => dayjs(r.createdAt).format("YYYY-MM-DD") },
            { title: "状态", key: "a", width: 90, render: (_, r) => (r.active ? <Tag color="success">已开通</Tag> : <Tag color="warning">待开通</Tag>) },
            {
              title: "", key: "act", width: 90,
              render: (_, r) => (
                <Button size="small" type={r.active ? "default" : "primary"} danger={r.active} loading={忙 === r.id} onClick={() => void 切(r)}>
                  {r.active ? "停用" : "开通"}
                </Button>
              ),
            },
          ]}
        />
      </卡片>
    </>
  );
}
