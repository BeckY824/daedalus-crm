"use client";

import { Tag, Avatar, Space, Typography, Progress } from "antd";
import { ArrowUpOutlined, ArrowDownOutlined } from "@ant-design/icons";
import Link from "next/link";
import { avatarColor, companyInitial, initial } from "@/lib/utils";
import { FOLLOW_STATUS_COLOR, OPP_STAGE_COLOR } from "@/lib/constants";

/** 页头：图标 + 大标题 + 副标题（对应设计稿左上角） */
export function PageHead({
  icon,
  title,
  subtitle,
  tag,
  tagNote,
  extra,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  tag?: string;
  tagNote?: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="page-head-icon">{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
        {tag && (
          <Space size={10} style={{ marginTop: 10 }}>
            <Tag color="blue" style={{ fontSize: 15, padding: "4px 15px", borderRadius: 16, margin: 0 }}>
              {tag}
            </Tag>
            {tagNote && (
              <Typography.Text type="secondary" style={{ fontSize: 15 }}>
                {tagNote}
              </Typography.Text>
            )}
          </Space>
        )}
      </div>
      {extra}
    </div>
  );
}

/** 首页指标卡 */
export function StatCard({
  icon,
  color,
  label,
  value,
  delta,
  deltaLabel = "较上月",
  note,
}: {
  icon: React.ReactNode;
  color: string;
  label: string;
  value: string | number;
  /** 与上月相比的百分比。**没有可比口径时不要传** —— 宁可不显示也不编一个 */
  delta?: number;
  deltaLabel?: string;
  /** 没有涨跌可显示时，用一句话说明这个数怎么算的，比留白强 */
  note?: string;
}) {
  const up = (delta ?? 0) >= 0;
  return (
    <div className="card-soft stat-card">
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div className="stat-icon" style={{ background: color + "1f", color }}>
          {icon}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="stat-label">{label}</div>
          <div className="stat-value">{value}</div>
        </div>
      </div>
      {delta !== undefined ? (
        <div className="stat-delta">
          {deltaLabel}{" "}
          {delta === 0 ? (
            "持平"
          ) : (
            <span style={{ color: up ? "#16a34a" : "#dc2626", fontWeight: 500 }}>
              {up ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {Math.abs(delta)}%
            </span>
          )}
        </div>
      ) : note ? (
        <div className="stat-delta">{note}</div>
      ) : null}
    </div>
  );
}

/** 客户名称前的方块徽标 */
export function CompanyLogo({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      className="company-logo"
      style={{ background: avatarColor(name), width: size, height: size, fontSize: size * 0.43 }}
    >
      {companyInitial(name)}
    </span>
  );
}

/** 人员头像 + 姓名 */
export function UserCell({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <Space size={8} style={{ maxWidth: "100%" }}>
      <Avatar size={size} style={{ background: avatarColor(name), fontSize: size * 0.45, flex: "none" }}>
        {initial(name)}
      </Avatar>
      {/* 名字长了要省略号收尾，不能溢出到相邻元素上（业绩排行里就压在进度条上过） */}
      <span
        title={name}
        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
      >
        {name}
      </span>
    </Space>
  );
}

export function FollowStatusTag({ status }: { status: string }) {
  return (
    <Tag color={FOLLOW_STATUS_COLOR[status] ?? "default"} style={{ margin: 0, borderRadius: 6, fontSize: 13 }}>
      {status}
    </Tag>
  );
}

export function StageTag({ stage }: { stage: string }) {
  const c = OPP_STAGE_COLOR[stage] ?? "#94a3b8";
  return (
    <Tag style={{ margin: 0, borderRadius: 6, fontSize: 13, color: c, background: c + "18", borderColor: c + "35" }}>
      {stage}
    </Tag>
  );
}

/** 成交概率：数值 + 细进度条 */
export function ProbabilityCell({ value }: { value: number }) {
  const color = value >= 70 ? "#16a34a" : value >= 40 ? "#1668dc" : "#f59e0b";
  return (
    <div style={{ minWidth: 90 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 3 }}>{value}%</div>
      <Progress percent={value} showInfo={false} size="small" strokeColor={color} />
    </div>
  );
}

export function CustomerLink({ id, name }: { id: string; name: string }) {
  return (
    <Space size={10}>
      <CompanyLogo name={name} />
      <Link href={`/customers/${id}`} className="link-strong">
        {name}
      </Link>
    </Space>
  );
}
