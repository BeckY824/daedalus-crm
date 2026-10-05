"use client";

import { 签约叫 } from "@/lib/business-config";
import OptionInput from "@/components/OptionInput";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Input, Button, Space, Select, Tag, Modal, Form, Row, Col, App } from "antd";
import {
  PlusOutlined,
  SwapRightOutlined,
  DeleteOutlined,
  EditOutlined,
} from "@ant-design/icons";
import ResetFilters from "@/components/ResetFilters";
import { 列表不问归属 } from "@/lib/solo";
import ListSearch from "@/components/ListSearch";
import { PageHead, UserCell } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
import { LEAD_STATUSES, LEAD_STATUS_COLOR } from "@/lib/constants";
import { 成员选项, 独自一人, 可选成员, smartTime } from "@/lib/utils";
import { saveLead, deleteLeads, convertLead, mergeLeadInto, type 线索撞号 } from "./actions";
import { useBusiness } from "@/lib/business-client";
import { useUrlFilters } from "@/lib/url-filters";
import { 聚焦首项 } from "@/lib/modal-focus";
import { 转化会带上 } from "@/lib/lead-convert";

type Row = {
  id: string;
  name: string;
  contact: string | null;
  phone: string | null;
  email: string | null;
  industry: string | null;
  source: string;
  status: string;
  remark: string | null;
  ownerId: string | null;
  ownerName: string;
  customerId: string | null;
  createdAt: string;
  /** 编辑框的版本号（排查 D3） */
  updatedAt: string;
};

export default function LeadsView({
  rows,
  总数,
  users,
  filters,
  来源们,
  me,
}: {
  rows: Row[];
  /** 库里一共多少条。行只取了前 300，分页条不能拿行数冒充总数 */
  总数: number;
  users: 可选成员[];
  filters: { keyword: string; status: string; ownerId: string; source: string };
  /** 来源筛选的候选：设置里的 + 库里用着的 */
  来源们: string[];
  me: string;
}) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const b = useBusiness();
  const { f, setF, apply, reset, pending } = useUrlFilters("/leads", filters);
  /** 空库 = 一条都没有**且**没在筛。筛出 0 条时筛选栏要留着，见 DataList */
  const 空库 = rows.length === 0 && !Object.values(filters).some((v) => v);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    if (!open) return;
    if (editing) form.setFieldsValue(editing);
    else {
      form.resetFields();
      // 来源不预填（审查 M13）：原来默认「官网注册」，忘了改就悄悄进了「按来源」统计，
      // 外贸预设里压根没有这一项，下拉还会显示一个不在选项里的值。不选就记成「其他」
      form.setFieldsValue({ status: "待跟进", ownerId: me });
    }
  }, [open, editing, form, me]);

  async function onOk() {
    const v = await form.validateFields();
    const res = await saveLead({ id: editing?.id, 版本: editing?.updatedAt, ...v });
    if (!res.ok) {
      message.error(res.error);
      return;
    }
    message.success(editing ? "已保存" : "线索已创建");
    setOpen(false);
    router.refresh();
  }

  /**
   * 转客户撞了号（J-024）：原来只报「请勿重复建档」，线索永远转不了。
   * 看得到那位客户 → 问要不要并过去；看不到（业务员撞同事的）→ 说清是谁的、找谁并
   */
  function 撞号了(r: Row, 撞: 线索撞号, 说法: string) {
    if (!撞.能并 || !撞.customerId) {
      modal.info({ title: 撞.客户名 ? `电话已经是「${撞.客户名}」的号码` : `电话已经在同事 ${撞.负责人} 名下`, content: 说法, okText: "知道了" });
      return;
    }
    const 到 = 撞.customerId;
    modal.confirm({
      title: `电话已经是${b.customer}「${撞.客户名}」的号码`,
      content: `负责人：${撞.负责人}。把「${r.name}」并到这位${b.customer}？线索标成已转化、关联到「${撞.客户名}」，不另建档案，也不改「${撞.客户名}」的资料。`,
      okText: `并到「${撞.客户名}」`,
      cancelText: "取消",
      async onOk() {
        const res = await mergeLeadInto(r.id, 到);
        if (res.ok) {
          message.success(`已并到「${撞.客户名}」`);
          router.push(`/customers/${res.customerId}`);
        } else message.error(res.error);
      },
    });
  }

  /** 只有一个人：负责人列不摆（审查 D2），见 lib/solo.ts */
  const 不问归属 = !f.ownerId && 列表不问归属(users, rows.map((r) => r.ownerName));

  const 列表: 列<Row>[] = [
    { title: "线索", key: "name", dataIndex: "name", width: 220, 常驻: true, render: (v) => <span className="link-strong">{v}</span> },
    { title: "联系人", key: "contact", dataIndex: "contact", width: 120, render: (v) => v ?? <span className="muted">—</span> },
    { title: "来源", key: "source", dataIndex: "source", width: 120, render: (v) => <Tag style={{ margin: 0, borderRadius: 6 }}>{v}</Tag> },
    {
      title: "状态", key: "status", dataIndex: "status", width: 110,
      render: (v) => (
        <Tag color={LEAD_STATUS_COLOR[v] ?? "default"} style={{ margin: 0, borderRadius: 6 }}>
          {v}
        </Tag>
      ),
    },
    ...(不问归属 ? [] : [{ title: "负责人", key: "ownerName", dataIndex: "ownerName", width: 140, render: (v: string) => <UserCell name={v} size={24} /> }]),
    { title: "创建时间", key: "createdAt", dataIndex: "createdAt", width: 116, render: (v) => <span className="muted nowrap">{smartTime(v)}</span> },

    { title: "联系电话", key: "phone", dataIndex: "phone", width: 140, 默认: false, render: (v) => v ?? <span className="muted">—</span> },
    { title: "所属行业", key: "industry", dataIndex: "industry", width: 130, 默认: false, render: (v) => <span className="muted">{v ?? "—"}</span> },
    { title: "邮箱", key: "email", dataIndex: "email", width: 200, 默认: false, render: (v) => v ?? <span className="muted">—</span> },
    {
      title: "", key: "act", width: 150, 常驻: true, fixed: "right",
      render: (_, r) =>
        r.customerId ? (
          <Link href={`/customers/${r.customerId}`}>查看{b.customer} ›</Link>
        ) : r.status === "已转化" ? (
          // 并到了一位已经关联着别的线索的客户（J-024，Lead.customerId 唯一）：没有直接的关联，按电话去客户列表找
          <Link href={`/customers?keyword=${encodeURIComponent(r.phone && !r.phone.includes("*") ? r.phone : r.name)}`}>查看{b.customer} ›</Link>
        ) : (
          <Space size={2}>
            <Button
              type="link"
              size="small"
              icon={<SwapRightOutlined />}
              onClick={() =>
                modal.confirm({
                  title: `将「${r.name}」转为${b.customer}？`,
                  // 按实际会填的格子、用当前叫法说（2026-10-04 L-016），见 lib/lead-convert.ts 转化会带上
                  content: (() => {
                    const 带 = 转化会带上(r, b.fields);
                    return `会建一位${b.customer}${带 ? `，${带}一起带过去` : ""}，线索标记为已转化。`;
                  })(),
                  okText: `转为${b.customer}`,
                  cancelText: "取消",
                  async onOk() {
                    const res = await convertLead(r.id);
                    if (res.ok) {
                      message.success(`已转为${b.customer}`);
                      router.push(`/customers/${res.customerId}`);
                    } else if (res.撞号) 撞号了(r, res.撞号, res.error);
                    else message.error(res.error);
                  },
                })
              }
            >
              转{b.customer}
            </Button>
            <Button
              aria-label={`编辑 ${r.name}`}
              title="编辑"
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => {
                setEditing(r);
                setOpen(true);
              }}
            />
            <Button
              aria-label={`删除 ${r.name}`}
              title="删除"
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() =>
                modal.confirm({
                  title: `删除线索「${r.name}」？`,
                  okText: "删除",
                  okButtonProps: { danger: true },
                  cancelText: "取消",
                  async onOk() {
                    const res = await deleteLeads([r.id]);
                    // 行可能已被别人删掉，如实说，别一律提示「已删除」
                    message.success(res.deleted ? "已删除" : "这条线索已经不在了（可能已删除）");
                    router.refresh();
                  },
                })
              }
            />
          </Space>
        ),
    },
  ];

  return (
    <>
      <PageHead
        title="线索"
        subtitle="还没建档的线索"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            新建线索
          </Button>
        }
      />

      <DataList<Row>
        截断={{ 总数 }}
        页="leads"
        空库={空库}
        列={列表}
        行={rows}
        加载中={pending}
        空态={{
          title: "还没有线索",
          hint: `线索是还没确认要不要跟的人。确认要跟了就转成${b.customer}，之后的跟进、商机、${签约叫(b)}都在${b.customer}那边走。`,
          primary: { label: "新建第一条线索", onClick: () => { setEditing(null); setOpen(true); } },
        }}
        筛选={
          <Space wrap size={[10, 10]}>
            <ListSearch
              width={280}
              placeholder="线索名称 / 联系人 / 电话"
              value={f.keyword}
              onChange={(v) => setF({ ...f, keyword: v })}
              onSearch={(v) => apply({ keyword: v })}
            />
            <Select
              style={{ width: 152 }}
              placeholder="全部状态"
              allowClear
              value={f.status || undefined}
              onChange={(v) => apply({ status: v ?? "" })}
              options={LEAD_STATUSES.map((s2) => ({ value: s2, label: s2 }))}
            />
            {/* 负责人、来源（T-029）：照客户列表的写法，只有一个人时负责人不摆 */}
            {!不问归属 && (
              <Select style={{ width: 150 }} placeholder="全部负责人" allowClear
                value={f.ownerId || undefined} onChange={(v) => apply({ ownerId: v ?? "" })}
                options={成员选项(users)} />
            )}
            <Select style={{ width: 140 }} placeholder="全部来源" allowClear
              value={f.source || undefined} onChange={(v) => apply({ source: v ?? "" })}
              options={来源们.map((s2) => ({ value: s2, label: s2 }))} />
            <ResetFilters 显示={Boolean(f.keyword || f.status || f.ownerId || f.source)} onClick={reset} />
          </Space>
        }
      />

      <Modal
        afterOpenChange={聚焦首项}
        open={open}
        title={editing ? "编辑线索" : "新建线索"}
        onCancel={() => setOpen(false)}
        onOk={onOk}
        okText="保存"
        cancelText="取消"
        width={600}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item name="name" label="线索名称" rules={[{ required: true, message: "请填写线索名称" }]}>
                <Input placeholder="公司名称或线索标题" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="contact" label="联系人"><Input placeholder="张经理" /></Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="phone" label="联系电话"><Input placeholder="13800002211" /></Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="email" label="邮箱"><Input /></Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="industry" label="所属行业">
                <OptionInput options={b.industries} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="source" label="线索来源">
                <OptionInput options={b.sources} placeholder="选或直接填" maxLength={30} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="status" label="状态">
                <Select options={LEAD_STATUSES.filter((s) => s !== "已转化").map((i) => ({ value: i, label: i }))} />
              </Form.Item>
            </Col>
            {/* 只有一个人时不问归属，见 lib/utils.ts 的 独自一人 */}
            {!独自一人(users, editing?.ownerId) && (
              <Col span={8}>
                <Form.Item name="ownerId" label="负责人">
                  <Select options={成员选项(users)} />
                </Form.Item>
              </Col>
            )}
            <Col span={24}>
              <Form.Item name="remark" label="备注">
                <Input.TextArea rows={2} placeholder="线索来源细节、初步需求…" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
}
