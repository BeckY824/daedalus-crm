/**
 * 并发编辑冲突检测。
 *
 * 场景：甲打开某学员的编辑框，还没保存；乙在同一时间改了同一条并先保存了。
 * 甲点保存时提交的是一整套「打开那一刻」的旧值，会把乙的改动整体盖掉，
 * 而且两人都收不到任何提示——这是这套系统里最容易丢数据、又最难事后察觉的一种。
 *
 * 做法是乐观锁 + 字段级合并：
 *   1. 表单带上打开时那一刻的 updatedAt 作为版本号，保存时放进 where。
 *      记录被人动过版本号就对不上，更新影响 0 行。
 *   2. 影响 0 行不等于真冲突。表单同时带上打开时看到的一整份快照（base），
 *      据此算出「对方改了哪些字段」和「我改了哪些字段」——
 *      两边没有交集就直接合并，有交集才拦。
 *
 * 第 2 步是必须的。少了它，日常最高频的路径会被误伤：乙只是给这个学员录了条跟进，
 * 根本没碰学员资料，甲的保存也会被拦下；而且提示还会把甲自己改的字段列成「冲突」，
 * 因为那时比的是「库里现值 vs 我要提交的值」，我自己的改动当然对不上。
 */

/** 编辑框里会提交的字段 → 界面上的叫法，用于告诉用户具体撞了哪几项 */
export const CUSTOMER_FIELD_LABELS: Record<string, string> = {
  name: "客户姓名",
  phone: "联系电话",
  school: "院校",
  grade: "年级",
  major: "专业",
  followStatus: "跟进状态",
  decisionStatus: "客户决策状态",
  expectedSignAt: "预计签约时间",
  remark: "备注",
  salesOwnerId: "销售负责人",
  channelId: "推荐渠道",
  referrerCustomerId: "推荐学员",
};

/** 术语化版本：院校/年级/专业与「推荐学员」按业务配置显示 */
export function customerFieldLabels(b: { customer: string; fields: { school: string; grade: string; major: string } }): Record<string, string> {
  return {
    ...CUSTOMER_FIELD_LABELS,
    school: b.fields.school,
    grade: b.fields.grade,
    major: b.fields.major,
    referrerCustomerId: `推荐${b.customer}`,
  };
}

/** 改了推荐人就要连带重算这几个归属字段，不能只写推荐人本身 */
export const REFERRER_KEYS = ["channelId", "referrerCustomerId"] as const;
export const ATTRIBUTION_KEYS = [
  "channelId",
  "attributionChannelId",
  "attributionCustomerId",
  "channelOwnerId",
] as const;

/** 空串、null、undefined 在业务上是同一件事；日期只比到毫秒 */
function normalize(v: unknown): string | number | boolean | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "object") return JSON.stringify(v);
  return v as string | number | boolean;
}

/**
 * 两份数据之间发生变化的字段名（原始 key，不是中文名）。
 * 只比较编辑框里的字段，`lastFollowAt` 这类系统字段不参与。
 */
export function diffKeys(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
): string[] {
  return Object.keys(CUSTOMER_FIELD_LABELS).filter(
    (k) => k in to && normalize(from[k]) !== normalize(to[k]),
  );
}

/** 把字段名换成界面上的叫法，用于提示文案 */
export function labelsOf(keys: readonly string[]): string[] {
  return keys.map((k) => CUSTOMER_FIELD_LABELS[k] ?? k);
}

/**
 * 列出「库里现在的值」与「本次提交的值」不一致的字段（中文名）。
 * 只在拿不到 base 快照时兜底用——它分不清哪些是对方改的、哪些是我自己改的。
 */
export function conflictingFields(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): string[] {
  return labelsOf(diffKeys(current, incoming));
}
