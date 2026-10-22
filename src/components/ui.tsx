"use client";

import { Tag, Avatar, Space } from "antd";
import { 主题颜色 } from "@/lib/chart-theme";
import { palette } from "@/lib/palette";
import {
  ArrowUpOutlined,
  ArrowDownOutlined,
  PhoneOutlined,
  TeamOutlined,
  ShopOutlined,
  MailOutlined,
  MessageOutlined,
  WhatsAppOutlined,
  WechatOutlined,
  CarryOutOutlined,
  BellOutlined,
  EllipsisOutlined,
  TagOutlined,
} from "@ant-design/icons";
import Link from "next/link";
import type { ComponentProps } from "react";
import { avatarColor, companyInitial, initial, AVATAR_TEXT } from "@/lib/utils";
import { FOLLOW_STATUS_COLOR, DECISION_STATUS_COLOR, OPP_STAGE_COLOR } from "@/lib/constants";
import { 跟进类型元 } from "@/lib/follow-types";
import { useBusiness } from "@/lib/business-client";
import { statusLabel, stageLabel } from "@/lib/business-config";

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
  titleAside,
}: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  tag?: string;
  tagNote?: string;
  extra?: React.ReactNode;
  /** 紧跟在标题右边的一小块（客户页的「客户 / 公海」页签）。不给就和原来一样只有标题 */
  titleAside?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div style={{ flex: 1, minWidth: 0 }}>
        {titleAside ? (
          <div className="page-head-t">
            <h1>{title}</h1>
            {titleAside}
          </div>
        ) : (
          <h1>{title}</h1>
        )}
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
    // 名字那一项要能缩：只给 span 省略号不够，外面那层 .ant-space-item 照样被长名字撑开（10-20 Windows 最窄窗口量出来伸出 18px），见 globals.css .user-cell
    <Space size={8} className="user-cell" style={{ maxWidth: "100%" }}>
      <Avatar size={size} style={{ background: avatarColor(name), color: AVATAR_TEXT, fontSize: size * 0.45, flex: "none" }}>
        {initial(name)}
      </Avatar>
      {/* 名字长了要省略号收尾，不能溢出到相邻元素上（业绩排行里就压在进度条上过） */}
      <span
        title={name}
        style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
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
  const b = useBusiness();
  // DOM使用CSS变量和color-mix，切主题时不依赖组件重渲染。
  const c = 主题颜色(OPP_STAGE_COLOR[stage] ?? palette.textMuted);
  return (
    <Tag style={{ margin: 0, borderRadius: 6, fontSize: 13, color: c, background: `color-mix(in srgb, ${c} 9.4%, transparent)`, borderColor: `color-mix(in srgb, ${c} 20.8%, transparent)` }}>
      {stageLabel(b, stage)}
    </Tag>
  );
}

/**
 * 列表里每一行上的链接：不预取（2026-10-20）。
 *
 * next/link 默认一进视口就预取目标页。客户名单、表格、时间线一屏几十上百行，
 * 每行都预取一遍详情页，渲染进程和本机服务端都白干活、白占内存，可人一次只点开一位。
 * 点了照常跳，只是不提前取。左栏导航、页里单个的「查看全部」之类仍用 Link，照旧预取。
 */
export function RowLink(props: ComponentProps<typeof Link>) {
  return <Link prefetch={false} {...props} />;
}

/**
 * 列表里「所属客户」那一格。给了 company（Customer.school，外贸叫公司、教培叫学校）就摆两行：
 * 上面人名可点，下面公司灰色小字、一行省略、悬停看全名（2026-10-19 用户定：不加新列，同一格两行）。
 * 没填公司不占第二行。logo={false} 给本来就不摆头像的列表（订单一览）用
 */
export function CustomerLink({ id, name, company, logo = true }: { id: string; name: string; company?: string | null; logo?: boolean }) {
  const 公司 = company?.trim();
  return (
    <span className="cust-link">
      {logo && <CompanyLogo name={name} />}
      <span className="cust-link-t">
        {/* 长名最多两行（2026-10-22 排版普查）：一长串没空格的英文原来竖着排了十行 */}
        <RowLink href={`/customers/${id}`} className="link-strong clamp" title={name}>
          {name}
        </RowLink>
        {公司 && (
          <span className="cust-link-co" title={公司}>
            {公司}
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * 跟进类型的图标。记录页的时间线和跟进记录表共用这一份——
 * 两处各画一份的时候，同一个「上门拜访」在一边是商店图标、另一边是彩色标签。
 * 按 icon 名取（lib/follow-types 的 跟进类型元().icon）：自定义渠道一律是 tag
 */
const 图标表: Record<string, React.ReactNode> = {
  phone: <PhoneOutlined />,
  team: <TeamOutlined />,
  shop: <ShopOutlined />,
  mail: <MailOutlined />,
  message: <MessageOutlined />,
  "whats-app": <WhatsAppOutlined />,
  wechat: <WechatOutlined />,
  "carry-out": <CarryOutOutlined />,
  bell: <BellOutlined />,
  ellipsis: <EllipsisOutlined />,
  tag: <TagOutlined />,
};
export const 跟进图标 = (icon: string) => 图标表[icon] ?? 图标表.ellipsis;

/** 一个跟进类型值的图标（含自定义渠道；认不出的按「其他记录」） */
export function FollowTypeIcon({ type }: { type: string }) {
  const b = useBusiness();
  return <>{跟进图标(跟进类型元(b.followTypes, type).icon)}</>;
}

/**
 * 跟进记录表里的「类型」列：**图标 + 文字**，不是一颗彩色药丸（设计稿 17/PAGE）。
 *
 * 这一页每行都有一个类型，八种类型八种颜色的话，整张表会变成一列跑马灯，
 * 而真正要读的「内容」那一列反而退到后面。颜色只留给图标，文字照常。
 */
export function FollowTypeCell({ type }: { type: string }) {
  const b = useBusiness();
  const m = 跟进类型元(b.followTypes, type);
  return (
    <span className="ftype">
      <span className="ftype-i" style={{ color: m.color }}>
        {跟进图标(m.icon)}
      </span>
      {m.label}
    </span>
  );
}
