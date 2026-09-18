"use client";

import { Tag, Avatar, Space, Progress } from "antd";
import { palette, categorical } from "@/lib/palette";
import {
  ArrowUpOutlined,
  ArrowDownOutlined,
  PhoneOutlined,
  TeamOutlined,
  ShopOutlined,
  MailOutlined,
  MessageOutlined,
  CarryOutOutlined,
  BellOutlined,
  EllipsisOutlined,
} from "@ant-design/icons";
import Link from "next/link";
import { avatarColor, companyInitial, initial, AVATAR_TEXT } from "@/lib/utils";
import { FOLLOW_STATUS_COLOR, DECISION_STATUS_COLOR, OPP_STAGE_COLOR, FOLLOW_TYPE_MAP } from "@/lib/constants";
import { useBusiness } from "@/lib/business-client";
import { statusLabel } from "@/lib/business-config";

/**
 * 页头：标题 + 一句副标题，**右侧放这一页的主动作**。
 *
 * 六张列表页、管道、计划、记录页的「新建 X / 记录跟进」全在这儿，位置一模一样——
 * 原来它们散在筛选栏里、表格上方，人每换一页都要重新找一遍。
 *
 * `extra` 外面那层 `.page-head-a` 不只是布局：⌘N「当前页新建」按它找主按钮
 * （见 CommandBar）。页头上有主按钮的页面，⌘N 就有意义；没有的页面它什么也不做。
 *
 * 早先的大图标色块和「权限清晰，数据安全可控」这类标语已去掉——那是给客户看的宣传语，
 * 不是给每天用的人看的界面。tag / tagNote / icon 参数保留只为不改所有调用处，不再渲染。
 */
export function PageHead({
  title,
  subtitle,
  extra,
}: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  tag?: string;
  tagNote?: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {extra && <div className="page-head-a">{extra}</div>}
    </div>
  );
}

/**
 * 指标卡。
 *
 * `href` 给了就整张卡可点——设计稿 08/DATA·NOW 的页面规则「关键指标可跳到明细」：
 * 去处必须是一个**能把这个数重新数一遍**的页面，不是一个大概相关的列表。
 * 落不了地的数只能让人干着急，所以点不进去的卡就不要装成能点的。
 */
export function StatCard({
  icon,
  color,
  label,
  value,
  delta,
  deltaLabel = "较上月",
  note,
  href,
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
  /** 点这张卡去哪把这个数重新数一遍 */
  href?: string;
}) {
  const up = (delta ?? 0) >= 0;
  const 卡 = (
    <div className={`card-soft stat-card${href ? " stat-card-go" : ""}`}>
      <div className="stat-label">
        <span>{label}</span>
        <span className="stat-icon" style={{ color }}>
          {icon}
        </span>
      </div>
      <div className="stat-value">{value}</div>
      {delta !== undefined ? (
        <div className="stat-delta">
          {deltaLabel}{" "}
          {delta === 0 ? (
            "持平"
          ) : (
            <span style={{ color: up ? "var(--success)" : "var(--danger)", fontWeight: 500 }}>
              {up ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {Math.abs(delta)}%
            </span>
          )}
        </div>
      ) : note ? (
        <div className="stat-delta">{note}</div>
      ) : null}
    </div>
  );
  return href ? (
    <Link href={href} aria-label={`${label}：${value}，查看明细`}>
      {卡}
    </Link>
  ) : (
    卡
  );
}

/** 客户名称前的方块徽标 */
export function CompanyLogo({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      className="company-logo"
      style={{ background: avatarColor(name), color: AVATAR_TEXT, width: size, height: size, fontSize: size * 0.43 }}
    >
      {companyInitial(name)}
    </span>
  );
}

/** 人员头像 + 姓名 */
export function UserCell({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <Space size={8} style={{ maxWidth: "100%" }}>
      <Avatar size={size} style={{ background: avatarColor(name), color: AVATAR_TEXT, fontSize: size * 0.45, flex: "none" }}>
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
  const b = useBusiness();
  return (
    <Tag color={FOLLOW_STATUS_COLOR[status] ?? "default"} style={{ margin: 0, borderRadius: 6, fontSize: 13 }}>
      {statusLabel(b, status)}
    </Tag>
  );
}

export function DecisionStatusTag({ status }: { status: string }) {
  const b = useBusiness();
  return (
    <Tag color={DECISION_STATUS_COLOR[status] ?? "default"} style={{ margin: 0, borderRadius: 6, fontSize: 13 }}>
      {statusLabel(b, status)}
    </Tag>
  );
}

export function StageTag({ stage }: { stage: string }) {
  // 这个值要拼 "18" / "35" 当透明度，只能是真 hex，不能写 var()
  const c = OPP_STAGE_COLOR[stage] ?? palette.textMuted;
  return (
    <Tag style={{ margin: 0, borderRadius: 6, fontSize: 13, color: c, background: c + "18", borderColor: c + "35" }}>
      {stage}
    </Tag>
  );
}

/** 成交概率：数值 + 细进度条 */
export function ProbabilityCell({ value }: { value: number }) {
  const color = value >= 70 ? palette.success : value >= 40 ? palette.brand : categorical.amber;
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

/**
 * 跟进类型的图标。记录页的时间线和跟进记录表共用这一份——
 * 两处各画一份的时候，同一个「上门拜访」在一边是商店图标、另一边是彩色标签。
 */
export const FOLLOW_TYPE_ICON: Record<string, React.ReactNode> = {
  PHONE: <PhoneOutlined />,
  MEETING: <TeamOutlined />,
  VISIT: <ShopOutlined />,
  EMAIL: <MailOutlined />,
  SMS: <MessageOutlined />,
  TASK: <CarryOutOutlined />,
  REMIND: <BellOutlined />,
  OTHER: <EllipsisOutlined />,
};

/**
 * 跟进记录表里的「类型」列：**图标 + 文字**，不是一颗彩色药丸（设计稿 17/PAGE）。
 *
 * 这一页每行都有一个类型，八种类型八种颜色的话，整张表会变成一列跑马灯，
 * 而真正要读的「内容」那一列反而退到后面。颜色只留给图标，文字照常。
 */
export function FollowTypeCell({ type }: { type: string }) {
  const m = FOLLOW_TYPE_MAP[type] ?? FOLLOW_TYPE_MAP.OTHER;
  return (
    <span className="ftype">
      <span className="ftype-i" style={{ color: m.color }}>
        {FOLLOW_TYPE_ICON[type] ?? FOLLOW_TYPE_ICON.OTHER}
      </span>
      {m.label}
    </span>
  );
}
