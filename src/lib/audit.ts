/**
 * 操作留痕。
 *
 * 「全员可见可改」这个决策成立的前提就是有据可查：不限制谁能改，
 * 但每次改了什么、谁改的、什么时候改的都留下来，出问题能追溯。
 * 因此这里记的是**写操作**，读操作不记（噪音太大，也没有追溯价值）。
 *
 * 两条硬规则：
 *   1. 写日志失败绝不能连累业务操作本身——宁可少一条日志，不能让销售存不上数据
 *   2. 日志只增不改不删，且不与 User 建外键，成员被删也不该影响历史记录
 */
import { prisma } from "./prisma";
import { CUSTOMER_FIELD_LABELS } from "./concurrency";

export type Actor = { id: string; name: string };

export async function recordAudit(input: {
  user: Actor;
  /** create | update | delete | assign | convert | deactivate | ... */
  action: string;
  /** 对象类型，如 Customer / Contract / Lead / User / Channel */
  entity: string;
  entityId?: string | null;
  /** 一句话说明，直接给人看 */
  summary: string;
  /** 结构化明细，存 JSON 字符串 */
  detail?: unknown;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: input.user.id,
        userName: input.user.name,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        summary: input.summary,
        detail: input.detail === undefined ? null : JSON.stringify(input.detail),
      },
    });
  } catch (e) {
    // 留痕是旁路，塌了也不能把主流程带下水
    console.error("写操作日志失败：", e);
  }
}

/** 把「哪些字段变了、从什么变成什么」整理成人能读的明细 */
export function describeCustomerChanges(
  keys: readonly string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return keys.map((k) => ({
    字段: CUSTOMER_FIELD_LABELS[k] ?? k,
    原值: 展示(before[k]),
    新值: 展示(after[k]),
  }));
}

function 展示(v: unknown): string {
  if (v == null || v === "") return "（空）";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}
