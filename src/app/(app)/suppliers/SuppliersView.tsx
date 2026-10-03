"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Space, Tag, Tooltip } from "antd";
import { PlusOutlined, WarningOutlined } from "@ant-design/icons";
import { PageHead } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
import ListSearch from "@/components/ListSearch";
import { useUrlFilters } from "@/lib/url-filters";
import { fmtDate } from "@/lib/utils";
import type { 供应商行 } from "@/lib/supplier-db";
import SupplierForm from "./SupplierForm";

const 评级色: Record<string, string> = { A: "success", B: "processing", C: "warning" };

/**
 * 供应商一览（2026-10-03 外贸第 3c 块）。一行一家：品类、地区、评级、合作过几单、比过几次价、
 * 出过问题的挂个小三角——选厂前扫一眼这一列就够。
 */
export default function SuppliersView({ rows, filters }: { rows: 供应商行[]; filters: { keyword: string } }) {
  const router = useRouter();
  const { f, setF, apply } = useUrlFilters("/suppliers", filters);
  const [新建, set新建] = useState(false);

  const 列表: 列<供应商行>[] = [
    {
      title: "供应商", key: "name", dataIndex: "name", width: 200, 常驻: true,
      render: (v: string, r) => (
        <Space size={6}>
          <Link href={`/suppliers/${r.id}`} className="link-strong">{v}</Link>
          {r.issues && <Tooltip title={`出过的问题：${r.issues}`}><WarningOutlined className="cmp-issue" aria-label="出过问题" /></Tooltip>}
        </Space>
      ),
    },
    { title: "品类", key: "category", dataIndex: "category", width: 140, render: (v: string | null) => v ?? <span className="muted">—</span> },
    { title: "地区", key: "region", dataIndex: "region", width: 110, render: (v: string | null) => v ?? <span className="muted">—</span> },
    { title: "评级", key: "rating", dataIndex: "rating", width: 70, render: (v: string | null) => (v ? <Tag color={评级色[v]}>{v}</Tag> : <span className="muted">—</span>) },
    { title: "合作", key: "合作单数", dataIndex: "合作单数", width: 80, render: (v: number) => (v ? `${v} 单` : <span className="muted">—</span>) },
    { title: "比价", key: "比价", width: 110, render: (_: unknown, r) => (r.比价 ? `${r.比价} 次${r.选用 ? ` · 选用 ${r.选用}` : ""}` : <span className="muted">—</span>) },
    { title: "最近报价", key: "最近报价", dataIndex: "最近报价", width: 100, render: (v: string | null) => (v ? fmtDate(v) : <span className="muted">—</span>) },
    { title: "开票", key: "invoice", dataIndex: "invoice", width: 120, 默认: false },
    { title: "联系人", key: "contact", dataIndex: "contact", width: 100, 默认: false },
  ];

  return (
    <>
      <PageHead
        title="供应商"
        subtitle="工厂档案、出过的问题、历次比价"
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => set新建(true)}>新建供应商</Button>}
      />
      <DataList<供应商行>
        页="suppliers"
        列={列表}
        行={rows}
        行链接={(r) => `/suppliers/${r.id}`}
        空库={rows.length === 0 && !filters.keyword}
        空态={{
          title: "还没有供应商",
          hint: "在商机上做「供应商比价」时写个名字就会顺手建一家；也可以在这里先把常用的工厂建好。",
          primary: { label: "新建第一家", onClick: () => set新建(true) },
          demo: false,
        }}
        筛选={
          <ListSearch width={240} placeholder="名称 / 品类 / 地区" value={f.keyword} onChange={(v) => setF({ ...f, keyword: v })} onSearch={(v) => apply({ keyword: v })} />
        }
      />
      <SupplierForm open={新建} onClose={(存了, id) => { set新建(false); if (存了 && id) router.push(`/suppliers/${id}`); }} />
    </>
  );
}
