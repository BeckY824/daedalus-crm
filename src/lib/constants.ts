// 业务枚举常量。SQLite 不支持 enum，取值统一在此维护。

export const INDUSTRIES = [
  "IT互联网",
  "软件服务",
  "智能制造",
  "文化传媒",
  "建筑工程",
  "电子科技",
  "生物医药",
  "设计服务",
  "商贸流通",
  "数据服务",
  "物流运输",
  "专业服务",
  "教育培训",
  "其他",
] as const;

export const CUSTOMER_SOURCES = [
  "官网注册",
  "电话咨询",
  "展会获取",
  "转介绍",
  "广告投放",
  "商务拓展",
  "其他",
] as const;

/** 跟进状态 —— 客户列表中的彩色标签 */


/** 商机阶段 —— 漏斗从上到下 */
export const OPP_STAGES = [
  "初步沟通",
  "需求确认",
  "方案报价",
  "谈判审核",
  "赢单成交",
] as const;
export type OppStage = (typeof OPP_STAGES)[number];

/** 各阶段默认成交概率 */
export const STAGE_PROBABILITY: Record<string, number> = {
  初步沟通: 20,
  需求确认: 40,
  方案报价: 60,
  谈判审核: 80,
  赢单成交: 100,
};

/** 商机状态。OPEN 进行中 / WON 已赢单 / LOST 已丢单 */
export const OPP_STATUSES = ["OPEN", "WON", "LOST"] as const;

export const OPP_STAGE_COLOR: Record<string, string> = {
  初步沟通: "#2563eb",
  需求确认: "#22c55e",
  方案报价: "#eab308",
  谈判审核: "#f97316",
  赢单成交: "#ec4899",
};


export const LEAD_STATUSES = ["待跟进", "跟进中", "已转化", "已放弃"] as const;
export const LEAD_STATUS_COLOR: Record<string, string> = {
  待跟进: "orange",
  跟进中: "processing",
  已转化: "success",
  已放弃: "default",
};

/** 跟进记录类型 */
export const FOLLOW_TYPES = [
  { value: "PHONE", label: "电话沟通", color: "#22c55e", icon: "phone" },
  { value: "MEETING", label: "线上会议", color: "#2563eb", icon: "team" },
  { value: "VISIT", label: "上门拜访", color: "#8b5cf6", icon: "shop" },
  { value: "EMAIL", label: "邮件沟通", color: "#a855f7", icon: "mail" },
  { value: "SMS", label: "短信沟通", color: "#06b6d4", icon: "message" },
  { value: "TASK", label: "跟进任务", color: "#f59e0b", icon: "carry-out" },
  { value: "REMIND", label: "跟进提醒", color: "#f97316", icon: "bell" },
  { value: "OTHER", label: "其他记录", color: "#94a3b8", icon: "ellipsis" },
] as const;

export const FOLLOW_TYPE_MAP = Object.fromEntries(
  FOLLOW_TYPES.map((t) => [t.value, t]),
) as Record<string, (typeof FOLLOW_TYPES)[number]>;

export const FOLLOW_METHODS = [
  "电话沟通",
  "线上会议",
  "上门拜访",
  "邮件沟通",
  "微信沟通",
] as const;

export const FOLLOW_RECORD_STATUSES = ["已完成", "待处理", "已发送"] as const;
export const FOLLOW_RECORD_STATUS_COLOR: Record<string, string> = {
  已完成: "success",
  待处理: "warning",
  已发送: "processing",
};

export const ROLES = [
  { value: "ADMIN", label: "系统管理员" },
  { value: "MANAGER", label: "销售主管" },
  { value: "SALES", label: "销售" },
] as const;

/**
 * 能被指派为业务负责人的成员——销售负责人、渠道负责人、商机负责人、跟进人。
 *
 * **排除系统管理员**：管理员只做系统加工与维护，不承担销售职责。
 * 业绩排行榜（dashboard）一开始就是这个口径，各处负责人下拉一直没跟上，
 * 于是同一个系统里两套说法：排行榜不算管理员的业绩，下拉却让人选他。
 *
 * 例外是「停用并转交」的接收人下拉，那里仍列全部在职成员：
 * 转交是兜底操作，若排除管理员，最后一名销售离职时就无人可接。
 */
export const 可担任负责人 = { active: true, role: { not: "ADMIN" } };

/* ---------- 招生业务 ---------- */

/** 年级 */
export const GRADES = [
  "大一", "大二", "大三", "大四",
  "研一", "研二", "研三",
  "已毕业", "其他",
] as const;

/** 跟进状态：销售推进到哪一步 */
export const FOLLOW_STATUSES = [
  "待跟进",
  "跟进中",
  "已加微信",
  "已试听",
  "意向较高",
  "暂缓跟进",
  "已签约",
  "已流失",
] as const;
export type FollowStatus = (typeof FOLLOW_STATUSES)[number];

export const FOLLOW_STATUS_COLOR: Record<string, string> = {
  待跟进: "default",
  跟进中: "processing",
  已加微信: "cyan",
  已试听: "blue",
  意向较高: "green",
  暂缓跟进: "orange",
  已签约: "success",
  已流失: "error",
};

/** 客户决策状态：学员自己处在什么决策阶段 */
export const DECISION_STATUSES = [
  "了解中",
  "对比中",
  "与家人商议",
  "等待预算",
  "已决定报名",
  "暂不考虑",
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const DECISION_STATUS_COLOR: Record<string, string> = {
  了解中: "default",
  对比中: "processing",
  与家人商议: "cyan",
  等待预算: "orange",
  已决定报名: "success",
  暂不考虑: "error",
};
