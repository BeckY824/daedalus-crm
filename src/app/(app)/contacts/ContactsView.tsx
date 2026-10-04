"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Space, Avatar, Tag, Select } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import ResetFilters from "@/components/ResetFilters";
import { 列表不问归属 } from "@/lib/solo";
import { 关系候选 } from "@/lib/business-config";
import ListSearch from "@/components/ListSearch";
import { PageHead, CustomerLink, UserCell } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
import ContactForm from "../customers/[id]/ContactForm";
import { useContactRemoval } from "../customers/[id]/useContactRemoval";
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
  remark: string | null;
  updatedAt: string;
  /** 从客户上移出、人留着的（UnassignedContact）。没有所属客户，customerId 是空串 */
  未归属: boolean;
  /** 未归属的人原来是哪位客户的，鼠标停上去给人看 */
  原来: string | null;
  customerId: string;
  customerName: string;
  school: string | null;
  ownerName: string;
};

export default function ContactsView({
  rows: 全部行,
  总数,
  keyword,
  学员们,
  users,
}: {
  rows: Row[];
  /** 库里一共多少条。行只取了前 300，分页条不能拿行数冒充总数 */
  总数: number;
  keyword: string;
  /** 「添加联系人」时挑归属用的。联系人挂在某一位学员下面，没有归属的联系人没有意义 */
  /** label：重名的带公司和手机尾号（2026-10-04 J-016） */
  学员们: { id: string; name: string; label?: string }[];
  /** 负责人候选。只用来判断是不是只有一个人 */
  users: { name: string }[];
}) {
  const b = useBusiness();
  const router = useRouter();
  const [kw, setKw] = useState(keyword);
  const [pending, startTransition] = useTransition();
  const [表单开着, set表单开着] = useState(false);
  /** 点开的那位未归属联系人（编辑、挂回某位客户、彻底删除都在这个框里） */
  const [在改, set在改] = useState<Row | null>(null);
  const { 彻底删 } = useContactRemoval();

  /*
    关系和负责人两个筛选在本地做：这一页一次最多取 300 行，已经全在手上了，
    为两个下拉再跑一趟服务端不值当。关键词那个仍然走服务端——它要搜的是全库。
  */
  const [关系, set关系] = useState("");
  const [负责人, set负责人] = useState("");
  const [归属, set归属] = useState<"" | "有" | "无">("");
  const 有未归属 = 全部行.some((r) => r.未归属);
  const 关系选项 = useMemo(
    () => [...new Set(全部行.map((r) => r.position).filter(Boolean))].map((v) => ({ value: v as string, label: v as string })),
    [全部行],
  );
  const 负责人选项 = useMemo(
    () => [...new Set(全部行.filter((r) => !r.未归属).map((r) => r.ownerName))].map((v) => ({ value: v, label: v })),
    [全部行],
  );
  /** 只有一个人：负责人列和筛选都不摆（审查 D2），见 lib/solo.ts */
  const 不问归属 = !负责人 && 列表不问归属(users, 全部行.filter((r) => !r.未归属).map((r) => r.ownerName));
  const rows = useMemo(
    () =>
      全部行.filter(
        (r) =>
          (!关系 || r.position === 关系) &&
          (!负责人 || (!r.未归属 && r.ownerName === 负责人)) &&
          (!归属 || (归属 === "无") === r.未归属),
      ),
    [全部行, 关系, 负责人, 归属],
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
      render: (v, r) =>
        r.未归属 ? (
          <span className="muted" title={r.原来 ? `原来在「${r.原来}」下面` : undefined}>
            未归属
          </span>
        ) : (
          <CustomerLink id={r.customerId} name={v} />
        ),
    },
    // 「关系」就是他和这位的关系（本人、采购、财务；教培里是母亲、父亲），候选跟着业务配置走
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
    ...(不问归属 ? [] : [{ title: "负责人", 列名: "负责人", key: "ownerName", dataIndex: "ownerName", width: 140, render: (v: string, r: Row) => (r.未归属 ? <span className="muted">—</span> : <UserCell name={v} size={24} />) }]),

    { title: b.fields.school, key: "school", dataIndex: "school", width: 180, 默认: false, render: (v, r) => <span className="muted">{(!r.未归属 && v) || "—"}</span> },
    { title: "邮箱", key: "email", dataIndex: "email", width: 220, 默认: false, render: (v) => v ?? <span className="muted">—</span> },
  ];

  function search(v: string) {
    startTransition(() => router.push(v ? `/contacts?keyword=${encodeURIComponent(v)}` : "/contacts"));
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
        // 关系、负责人、归属是在本地筛的：拿取回来的行数比，筛完行变少不算截断（J-015）
        截断={{ 总数, 取回: 全部行.length }}
        页="contacts"
        空库={全部行.length === 0 && !keyword}
        列={列表}
        行={rows}
        加载中={pending}
        // 未归属的人没有「他的客户」可去：点开就地编辑，在框里挂回某位或彻底删除
        行链接={(r) => (r.未归属 ? "" : `/customers/${r.customerId}`)}
        行点击={(r) => set在改(r)}
        空态={{
          title: "还没有联系人",
          hint: `联系人是${b.customer}那边真正在对话的人：${关系候选(b).slice(0, 3).join("、")}。他挂在某一位${b.customer}下面，所以要先有${b.customer}。`,
          primary:
            学员们.length > 0
              ? { label: "添加第一位联系人", onClick: () => set表单开着(true) }
              : { label: `去建第一位${b.customer}`, onClick: () => router.push("/customers?new=1") },
        }}
        筛选={
          <Space wrap size={[10, 10]}>
            <ListSearch width={300} placeholder={`姓名 / 电话 / 微信 / ${b.customer}`} value={kw} onChange={setKw} onSearch={search} />
            <Select
              style={{ width: 140 }}
              placeholder="全部关系"
              allowClear
              value={关系 || undefined}
              onChange={(v) => set关系(v ?? "")}
              options={关系选项}
            />
            {!不问归属 && (
              <Select
                style={{ width: 150 }}
                placeholder="全部负责人"
                allowClear
                value={负责人 || undefined}
                onChange={(v) => set负责人(v ?? "")}
                options={负责人选项}
              />
            )}
            {(有未归属 || 归属) && (
              <Select
                style={{ width: 140 }}
                placeholder="全部归属"
                allowClear
                value={归属 || undefined}
                onChange={(v) => set归属(v ?? "")}
                options={[
                  { value: "有", label: `挂在${b.customer}下` },
                  { value: "无", label: "未归属" },
                ]}
              />
            )}
            <ResetFilters
              显示={Boolean(keyword || 关系 || 负责人 || 归属)}
              onClick={() => {
                setKw("");
                set关系("");
                set负责人("");
                set归属("");
                startTransition(() => router.push("/contacts"));
              }}
            />
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

      <ContactForm
        open={在改 !== null}
        onClose={() => set在改(null)}
        onSaved={() => {
          set在改(null);
          router.refresh();
        }}
        学员们={学员们}
        record={在改}
        未归属
        onDelete={
          在改
            ? () => {
                const r = 在改;
                set在改(null);
                void 彻底删(r);
              }
            : undefined
        }
      />
    </>
  );
}
