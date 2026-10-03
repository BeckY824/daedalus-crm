"use client";

import { Table, Tag, Alert } from "antd";
import { UserCell } from "@/components/ui";
import { dayjs } from "@/lib/utils";
import { useBusiness } from "@/lib/business-client";

/** 设置 · 操作日志：每一次改动的记录，只增不改不删。最近 200 条由 SettingsBody 取好传进来 */

export type AuditRow = {
  id: string;
  at: string;
  userName: string;
  action: string;
  entity: string;
  summary: string;
  detail: string | null;
};

/** 动作与对象的中文叫法，日志里直接显示英文没人看得懂 */
const ACTION_LABEL: Record<string, string> = {
  create: "新建", update: "修改", delete: "删除", assign: "转派",
  convert: "转化", deactivate: "停用", reactivate: "恢复", password: "改密码", device_revoke: "退出机器", ai_use: "AI", ai_apply: "确认 AI 建议", ai_undo: "撤销 AI 建议",
  pool: "放进公海", claim: "领取",
};
const ENTITY_LABEL: Record<string, string> = {
  Customer: "学员", Contract: "签约", Lead: "线索", User: "成员", Channel: "渠道", Setting: "系统设置", Ai: "AI 功能", Device: "机器",
};
/** 明细是入库时序列化的 JSON，格式化给人看；万一存了非法内容也不能让页面崩 */
function safeJson(raw: string | null): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const ACTION_COLOR: Record<string, string> = {
  create: "success", update: "processing", delete: "error",
  assign: "cyan", convert: "gold", deactivate: "warning", reactivate: "default", password: "default", ai_use: "purple", ai_apply: "green", ai_undo: "default",
  pool: "default", claim: "cyan",
};

export default function AuditTab({ logs }: { logs: AuditRow[] }) {
  const b = useBusiness();
  return (
    <>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 14 }}
                title={`所有人都能查看和修改全部${b.customer}数据，因此每一次改动都会记录在这里`}
                description="记录只增不改不删，成员被停用或删除后其历史操作仍然保留。此处显示最近 200 条。"
              />
              <Table<AuditRow>
                rowKey="id"
                size="middle"
                dataSource={logs}
                pagination={{ pageSize: 20, showSizeChanger: false }}
                locale={{ emptyText: "还没有任何操作记录" }}
                expandable={{
                  // 明细是 JSON，平时折起来，要追细节时再展开
                  rowExpandable: (r) => !!r.detail,
                  expandedRowRender: (r) => (
                    <pre
                      style={{
                        margin: 0,
                        fontSize: 12,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                        color: "var(--ink-soft)",
                      }}
                    >
                      {safeJson(r.detail)}
                    </pre>
                  ),
                }}
                columns={[
      {
                    title: "时间",
                    dataIndex: "at",
                    width: 170,
                    render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm:ss"),
                  },
      {
                    title: "操作人",
                    dataIndex: "userName",
                    width: 130,
                    render: (v: string) => <UserCell name={v} size={26} />,
                  },
      {
                    title: "动作",
                    dataIndex: "action",
                    width: 100,
                    render: (v: string) => (
                      <Tag color={ACTION_COLOR[v] ?? "default"} style={{ margin: 0, borderRadius: 6 }}>
                        {ACTION_LABEL[v] ?? v}
                      </Tag>
                    ),
                  },
      {
                    title: "对象",
                    dataIndex: "entity",
                    width: 90,
                    render: (v: string) => (v === "Customer" ? b.customer : ENTITY_LABEL[v] ?? v),
                  },
                  { title: "内容", dataIndex: "summary" },
                ]}
              />
    </>
  );
}
