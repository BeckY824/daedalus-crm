"use client";

import { useEffect, useState } from "react";
import { App, Alert, Button, Popconfirm, Table, Tag, Typography } from "antd";
import { smartTime } from "@/lib/utils";
import { 最近批次, 撤销批次, type 批次 } from "@/app/(app)/customers/import-actions";

/**
 * 设置页的「导入记录」栏：最近几批导入，每批一颗撤销。
 *
 * **为什么撤销要在这儿而不只在导完那一屏。**
 * 导完那一屏的撤销只救得了「当场就发现导错了」的人。
 * 真实的情形是第二天翻客户列表才发现号码那一列错位了——
 * 那时候导入抽屉早就关了，而这批数据有几百条，手工删不现实。
 *
 * 撤销的分寸和那一屏完全一致（同一个 server action）：
 * 新建的删掉、补上的还原，**导入之后被人动过的那几位留着并说清是哪几位**。
 */
export default function ImportsTab() {
  const { message, modal } = App.useApp();
  const [行, set行] = useState<批次[] | null>(null);
  const [忙, set忙] = useState<string | null>(null);

  const 拉 = () => 最近批次().then(set行).catch(() => set行([]));
  useEffect(() => {
    void 拉();
  }, []);

  async function 撤(b: 批次) {
    set忙(b.id);
    try {
      const r = await 撤销批次(b.id).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : "撤销没能完成，请重试" }));
      if (!r.ok) return message.error(r.error);
      const 尾 = r.没动.length
        ? `。有 ${r.没动.length} 位没动：${r.没动.slice(0, 5).map((x) => `${x.name}（${x.原因}）`).join("、")}${r.没动.length > 5 ? " 等" : ""}`
        : "";
      modal.success({ title: "已撤销这一批", content: `删掉 ${r.删掉} 条，还原 ${r.还原} 条${尾}` });
      await 拉();
    } finally {
      set忙(null);
    }
  }

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        title="每一次导入都是一个批次，整批可以撤销"
        description="撤销会删掉这一批新建的记录、还原这一批补上的空字段。导入之后你已经改过、或者已经有跟进记录的那几位会留着，撤销时会告诉你是哪几位。"
      />
      <Table<批次>
        rowKey="id"
        size="middle"
        loading={行 === null}
        dataSource={行 ?? []}
        pagination={false}
        locale={{ emptyText: "还没有导入过" }}
        columns={[
          { title: "文件", dataIndex: "fileName", ellipsis: true },
          { title: "什么时候", dataIndex: "at", width: 140, render: (v: string) => smartTime(new Date(v)) },
          { title: "谁导的", dataIndex: "userName", width: 100 },
          {
            title: "结果",
            width: 170,
            render: (_, r) => (
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                新建 {r.created} 条{r.updated ? `，补空 ${r.updated} 条` : ""}
              </Typography.Text>
            ),
          },
          {
            title: "",
            width: 110,
            align: "right",
            render: (_, r) =>
              r.revertedAt ? (
                <Tag>已撤销</Tag>
              ) : (
                <Popconfirm
                  title="撤销这一批导入？"
                  description={`会删掉 ${r.created} 条新建的记录。导入之后你改过的那几位会留着。`}
                  okText="撤销"
                  okButtonProps={{ danger: true }}
                  cancelText="不了"
                  onConfirm={() => 撤(r)}
                >
                  <Button size="small" danger loading={忙 === r.id}>撤销</Button>
                </Popconfirm>
              ),
          },
        ]}
      />
    </>
  );
}
