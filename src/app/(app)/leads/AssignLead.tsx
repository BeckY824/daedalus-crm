"use client";
/**
 * 企业版「线索分配和配额」的两块界面（F2 / F7，10-25 实测）：
 * - AssignLeadModal：选接手人、业务线、种类，走 分配线索()——查角色、配额、权限，记进分配记录。原来只有编辑弹窗里能随手改负责人
 * - 我分出去的：分出去的线索在别人名下，「按组织架构看客户」开着时列表里看不到，这里看它们后来怎样了
 * 规则判断都在服务端，这里只摆样子、原样报错
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Form, Modal, Select, Table, Tag } from "antd";
import { SendOutlined } from "@ant-design/icons";
import { LEAD_STATUS_COLOR } from "@/lib/constants";
import { smartTime } from "@/lib/utils";
import { 分配线索, 本月分配情况, 我分出去的线索, type 分配情况 } from "./assign-actions";
import type { 分出去的线索 } from "@/lib/enterprise/lead-assign";

const 配额说法 = (p: 分配情况[number]) => `本月 ${p.已分} / ${p.配额 ?? "不限"}`;

/** 给一条线索点「分配」：lead = null 时不显示 */
export function AssignLeadModal({ lead, 关 }: { lead: { id: string; name: string; ownerId: string | null } | null; 关: () => void }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [form] = Form.useForm<{ toUserId: string; line: "" | "内贸" | "外贸"; kind: "营销" | "营销企划" }>();
  const [人们, set人们] = useState<分配情况 | null>(null);
  const [忙, set忙] = useState(false);

  // 每次打开重取一遍：配额、已分随时在变
  function 打开了(open: boolean) {
    if (!open) return;
    form.resetFields();
    set人们(null);
    void 本月分配情况().then((r) => set人们(r ?? []));
  }

  async function 分() {
    if (!lead || 忙) return;
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    set忙(true);
    try {
      const res = await 分配线索({ leadId: lead.id, toUserId: v.toUserId, line: v.line || null, kind: v.kind });
      if (!res.ok) {
        message.error(res.error, 5);
        return;
      }
      message.success(`「${lead.name}」已分给 ${人们?.find((p) => p.userId === v.toUserId)?.name ?? "他"}`);
      关();
      router.refresh();
    } finally {
      set忙(false);
    }
  }

  return (
    <Modal
      open={!!lead}
      title={lead ? `分配「${lead.name}」` : ""}
      okText="分配"
      cancelText="取消"
      confirmLoading={忙}
      onOk={() => void 分()}
      onCancel={关}
      afterOpenChange={打开了}
      forceRender
    >
      <p className="muted" style={{ marginTop: 0 }}>只能分给销售或销售管理；配额分满了会拦下，分完记进分配记录。</p>
      <Form form={form} layout="vertical" initialValues={{ line: "", kind: "营销" }}>
        <Form.Item name="toUserId" label="接手人" rules={[{ required: true, message: "选一个接手人" }]}>
          <Select
            showSearch
            optionFilterProp="label"
            loading={人们 === null}
            placeholder="选销售或销售管理"
            notFoundContent={人们 === null ? "加载中…" : "组织里还没有销售：先在 设置 → 组织架构 里排好"}
            options={(人们 ?? [])
              .filter((p) => p.userId !== lead?.ownerId)
              .map((p) => ({ value: p.userId, label: `${p.name}${p.line ? `（${p.line}）` : ""} · ${配额说法(p)}` }))}
          />
        </Form.Item>
        <Form.Item name="line" label="业务线" extra="选了业务线，只能分给这条线（或没定线）的销售">
          <Select options={[{ value: "", label: "不限" }, { value: "内贸", label: "内贸" }, { value: "外贸", label: "外贸" }]} />
        </Form.Item>
        <Form.Item name="kind" label="线索种类">
          <Select options={[{ value: "营销", label: "营销" }, { value: "营销企划", label: "营销企划" }]} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 页头的「我分出去的」：点开看我分出去（或我点分配）的线索现在的状态 */
export function AssignedOutButton() {
  const [开, set开] = useState(false);
  const [行, set行] = useState<分出去的线索[] | null>(null);

  function 打开() {
    set开(true);
    set行(null);
    void 我分出去的线索().then((r) => set行(r ?? []));
  }

  return (
    <>
      <Button icon={<SendOutlined />} onClick={打开}>我分出去的</Button>
      <Modal open={开} title="我分出去的线索" footer={null} width={760} onCancel={() => set开(false)} destroyOnHidden>
        <p className="muted" style={{ marginTop: 0 }}>你分出去、或原来在你名下被分走的线索；同一条分了几次只算最近一次。</p>
        <Table<分出去的线索>
          size="small"
          rowKey="leadId"
          loading={行 === null}
          dataSource={行 ?? []}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          locale={{ emptyText: "还没有分出去的线索" }}
          scroll={{ x: 680 }}
          columns={[
            { title: "线索", dataIndex: "name", width: 180 },
            {
              title: "状态", dataIndex: "status", width: 90,
              render: (v: string) => <Tag color={LEAD_STATUS_COLOR[v]} style={{ margin: 0 }}>{v}</Tag>,
            },
            { title: "接手人", dataIndex: "接手人", width: 100 },
            {
              title: "现在在谁名下", dataIndex: "当前负责人", width: 110,
              render: (v: string | null, r) => (v === r.接手人 ? <span className="muted">同接手人</span> : v ?? <span className="muted">—</span>),
            },
            { title: "业务线", dataIndex: "line", width: 80, render: (v: string | null) => v ?? <span className="muted">不限</span> },
            { title: "分配时间", dataIndex: "分配时间", width: 120, render: (v: string) => <span className="muted nowrap">{smartTime(v)}</span> },
          ]}
        />
      </Modal>
    </>
  );
}
