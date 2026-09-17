"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input, Button, Space, Avatar, Tag, Select } from "antd";
import { SearchOutlined, ReloadOutlined, PlusOutlined } from "@ant-design/icons";
import { PageHead, CustomerLink, UserCell } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
import ContactForm from "../customers/[id]/ContactForm";
import { avatarColor, initial, AVATAR_TEXT } from "@/lib/utils";
import { useBusiness } from "@/lib/business-client";

type Row = {
  id: string;
  name: string;
  position: string | null;
  phone: string | null;
  email: string | null;
  wechat: string | null;
  isPrimary: boolean;
  customerId: string;
  customerName: string;
  school: string | null;
  ownerName: string;
};

export default function ContactsView({
  rows: 全部行,
  keyword,
  学员们,
}: {
  rows: Row[];
  keyword: string;
  /** 「添加联系人」时挑归属用的。联系人挂在某一位学员下面，没有归属的联系人没有意义 */
  学员们: { id: string; name: string }[];
}) {
  const b = useBusiness();
  const router = useRouter();
  const [kw, setKw] = useState(keyword);
  const [pending, startTransition] = useTransition();
  const [表单开着, set表单开着] = useState(false);

  /*
    关系和负责人两个筛选在本地做：这一页一次最多取 300 行，已经全在手上了，
    为两个下拉再跑一趟服务端不值当。关键词那个仍然走服务端——它要搜的是全库。
  */
  const [关系, set关系] = useState("");
  const [负责人, set负责人] = useState("");
  const 关系选项 = useMemo(
    () => [...new Set(全部行.map((r) => r.position).filter(Boolean))].map((v) => ({ value: v as string, label: v as string })),
    [全部行],
  );
  const 负责人选项 = useMemo(
    () => [...new Set(全部行.map((r) => r.ownerName))].map((v) => ({ value: v, label: v })),
    [全部行],
  );
  const rows = useMemo(
    () => 全部行.filter((r) => (!关系 || r.position === 关系) && (!负责人 || r.ownerName === 负责人)),
    [全部行, 关系, 负责人],
  );

  const 列表: 列<Row>[] = [
    {
      title: "联系人", key: "name", dataIndex: "name", width: 200, 常驻: true,
      render: (v, r) => (
        <Space size={8}>
          <Avatar size={24} style={{ background: avatarColor(v), color: AVATAR_TEXT, fontSize: 12 }}>{initial(v)}</Avatar>
          <span style={{ fontWeight: 500 }}>{v}</span>
          {r.isPrimary && (
            <Tag color="blue" style={{ margin: 0, borderRadius: 6 }}>
              关键
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: `所属${b.customer}`, 列名: `所属${b.customer}`, key: "customerName", dataIndex: "customerName", width: 240,
      render: (v, r) => <CustomerLink id={r.customerId} name={v} />,
    },
    // 「关系」就是他和这位的关系（母亲、班主任、同学），不是公司里的职务
    { title: "关系", key: "position", dataIndex: "position", width: 120, render: (v) => v ?? <span className="muted">—</span> },
    {
      title: "电话 · 微信", 列名: "电话 · 微信", key: "phone", width: 220,
      render: (_, r) =>
        r.phone || r.wechat ? (
          <span className="nowrap">
            {r.phone ?? "—"}
            {r.wechat && <span className="muted"> · {r.wechat}</span>}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { title: "负责人", 列名: "负责人", key: "ownerName", dataIndex: "ownerName", width: 140, render: (v) => <UserCell name={v} size={24} /> },

    { title: b.fields.school, key: "school", dataIndex: "school", width: 180, 默认: false, render: (v) => <span className="muted">{v ?? "—"}</span> },
    { title: "邮箱", key: "email", dataIndex: "email", width: 220, 默认: false, render: (v) => v ?? <span className="muted">—</span> },
  ];

  function search() {
    startTransition(() =>
      router.push(kw ? `/contacts?keyword=${encodeURIComponent(kw)}` : "/contacts"),
    );
  }

  return (
    <>
      {/*
        「添加联系人」在这儿也给一个（设计稿 14/PAGE）。
        它和页面规则「优先从记录页添加」不矛盾：规则说的是**填得对**——
        联系人必须挂在某一位学员下面，所以这条路的第一格就是选人，
        选完之后用的是记录页那张同一个表单（components 只有一份）。
      */}
      <PageHead
        title="联系人"
        subtitle="档案里的联系人"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => set表单开着(true)} disabled={学员们.length === 0}>
            添加联系人
          </Button>
        }
      />

      <DataList<Row>
        页="contacts"
        空库={全部行.length === 0 && !keyword}
        列={列表}
        行={rows}
        加载中={pending}
        行链接={(r) => `/customers/${r.customerId}`}
        空态={{
          title: "还没有联系人",
          hint: `联系人是${b.customer}那边真正在对话的人：家长、同学、带教老师。他挂在某一位${b.customer}下面，所以要先有${b.customer}。`,
          primary:
            学员们.length > 0
              ? { label: "添加第一位联系人", onClick: () => set表单开着(true) }
              : { label: `去建第一位${b.customer}`, onClick: () => router.push("/customers?new=1") },
        }}
        筛选={
          <Space wrap size={[10, 10]}>
            <Input
              style={{ width: 300 }}
              placeholder={`姓名 / 电话 / 微信 / ${b.customer}`}
              prefix={<SearchOutlined style={{ color: "var(--text-muted)" }} />}
              value={kw}
              allowClear
              onChange={(e) => {
                const v = e.target.value;
                setKw(v);
                if (!v) startTransition(() => router.push("/contacts"));
              }}
              onPressEnter={search}
            />
            <Select
              style={{ width: 140 }}
              placeholder="全部关系"
              allowClear
              value={关系 || undefined}
              onChange={(v) => set关系(v ?? "")}
              options={关系选项}
            />
            <Select
              style={{ width: 150 }}
              placeholder="全部负责人"
              allowClear
              value={负责人 || undefined}
              onChange={(v) => set负责人(v ?? "")}
              options={负责人选项}
            />
            {(keyword || 关系 || 负责人) && (
              <Button
                icon={<ReloadOutlined />}
                onClick={() => {
                  setKw("");
                  set关系("");
                  set负责人("");
                  startTransition(() => router.push("/contacts"));
                }}
              >
                重置
              </Button>
            )}
          </Space>
        }
      />

      <ContactForm
        open={表单开着}
        onClose={() => set表单开着(false)}
        onSaved={() => {
          set表单开着(false);
          router.refresh();
        }}
        学员们={学员们}
        record={null}
      />
    </>
  );
}
