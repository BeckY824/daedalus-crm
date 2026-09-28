"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Input, Segmented, Select, Table } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { 站内, 页头 } from "../OpsShell";
import { 卡片, 头像, 何时, 千分位, 次数条, 系统们 } from "../ui";
import type { 账号行 } from "../data";

type 来路筛 = "全部" | "桌面端" | "网页版";
type 系统筛 = "全部" | "Mac" | "Windows" | "未知";

/**
 * 用户列表。一个云端账号一行，整行可点、点进详情。
 *
 * 默认按「最近活跃」排：运营台最常问的是「最近谁在用」，不是「谁先注册」。
 * 搜索认名字和联系方式；筛选只摆两个最常用的（来路、系统），别的点进详情看。
 */
export default function UsersView({ token, 账号 }: { token: string; 账号: 账号行[] }) {
  const router = useRouter();
  const [搜, set搜] = useState("");
  const [来路, set来路] = useState<来路筛>("全部");
  const [系统, set系统] = useState<系统筛>("全部");

  const 看得见 = useMemo(() => {
    const 词 = 搜.trim().toLowerCase();
    return 账号
      .filter((a) => (来路 === "全部" ? true : a.来路 === 来路))
      // 「未知」= 有设备、但那台还没报过系统（0.46.6 及以前装的），不是「没有设备」
      .filter((a) => (系统 === "全部" ? true : a.分布[系统] > 0))
      .filter((a) => !词 || `${a.name} ${a.contact}`.toLowerCase().includes(词))
      .sort((a, b) => (b.最近活跃 ?? "").localeCompare(a.最近活跃 ?? ""));
  }, [账号, 搜, 来路, 系统]);

  const 桌面 = 账号.filter((a) => a.来路 === "桌面端").length;

  return (
    <>
      <页头 标题="用户" 说明={`共 ${账号.length} 个账号，其中 ${桌面} 个只用桌面端。点一行看这个人的设备、AI 用量和反馈`} />

      <卡片 平>
        <div className="opx-bar">
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: "var(--x-faint)" }} />}
            placeholder="搜名字、邮箱或手机号"
            value={搜}
            onChange={(e) => set搜(e.target.value)}
            style={{ width: 260 }}
          />
          <Segmented<来路筛> value={来路} onChange={set来路} options={["全部", "桌面端", "网页版"]} />
          <Select<系统筛>
            value={系统}
            onChange={set系统}
            style={{ width: 130 }}
            options={[
              { value: "全部", label: "全部系统" },
              { value: "Mac", label: "Mac" },
              { value: "Windows", label: "Windows" },
              { value: "未知", label: "系统未知" },
            ]}
            aria-label="按系统筛"
          />
          <span className="opx-bar-r">显示 {看得见.length} 个</span>
        </div>
        <Table<账号行>
          rowKey="id"
          size="middle"
          dataSource={看得见}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          scroll={{ x: 980 }}
          locale={{ emptyText: <div className="opx-empty">没有符合条件的人</div> }}
          rowClassName={() => "opx-row-link"}
          onRow={(a) => ({ onClick: () => router.push(站内(token, `/users/${a.id}`)) })}
          columns={[
            {
              title: "用户",
              render: (_, a) => (
                <div className="opx-who">
                  <头像 名={a.name} />
                  <div style={{ minWidth: 0 }}>
                    <b>
                      {a.name}
                      {!a.active && (
                        <span className="opx-tag opx-tag-dead" style={{ marginLeft: 8 }}>
                          已停用
                        </span>
                      )}
                    </b>
                    <small>{a.contact || "—"}</small>
                  </div>
                </div>
              ),
            },
            {
              title: "来路",
              width: 96,
              render: (_, a) => <span className={`opx-tag${a.来路 === "桌面端" ? " opx-tag-blue" : ""}`}>{a.来路}</span>,
            },
            { title: "设备", width: 170, render: (_, a) => <系统们 分={a.分布} /> },
            {
              title: "版本",
              width: 96,
              render: (_, a) => (a.版本 ? <span className="opx-num">v{a.版本}</span> : <span className="opx-faint">{a.设备.length ? "未知" : "—"}</span>),
            },
            { title: "AI 次数", width: 150, render: (_, a) => <次数条 剩={a.ai.剩} 送={a.ai.送} /> },
            {
              title: "近 30 天模型调用",
              width: 110,
              className: "num",
              render: (_, a) => (a.近30天调用 ? 千分位(a.近30天调用) : <span className="opx-faint">0</span>),
            },
            { title: "最近活跃", width: 110, render: (_, a) => <span className="opx-muted">{何时(a.最近活跃)}</span> },
            { title: "注册于", width: 124, className: "num", render: (_, a) => <span className="opx-muted" style={{ whiteSpace: "nowrap" }}>{a.createdAt.slice(0, 10)}</span> },
          ]}
        />
      </卡片>
    </>
  );
}
