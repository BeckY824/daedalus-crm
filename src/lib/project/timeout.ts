/**
 * 企业版超时回收（2026-10-24，D-34）：线索、商机阶段的项目在一个节点上太久没跟进，自动回到项目公海。
 * 这里只算日子（界面也引，不能碰 prisma）；扫库、回收、提醒在 lib/project/db.ts 的 公海超时收回。
 *
 * 规矩：
 *   - 老板按节点设最长处理天数，没设的节点不回收；订单阶段、已有结局的、已在公海的都不回收
 *   - 起点 = 最近一次「有人管」：建项目、换节点、接手（转让/领取）、客户上记了跟进，取最晚的
 *   - 起点 + 节点天数 那天还没新动静 → 回收（按自然日，和客户公海一样）
 *   - 记沟通时填了下一步时间：下一步那天过完还没跟进就回收，但不会比节点天数更晚（节点天数是上限）
 */
import { dayjs } from "@/lib/utils";
import type { 组织规则 } from "./org-rules";

export const 超时理由 = "超过节点处理时长没跟进，自动回到项目公海";

/**
 * 超时回收是系统做的：节点留痕（ProjectNodeLog.userId）、操作日志记在「系统」名下，不记在谁碰巧打开了页面、或夜扫找的那位老板名下（QA #16）。
 * 两列都不建外键（指向人的列），id 不是真成员；界面上按这个 id 显示「系统」
 */
export const 系统 = { id: "system", name: "系统" } as const;

export type 超时项目 = {
  phase: string;
  node: string;
  result?: string | null;
  pooledAt?: Date | string | null;
  nextStepAt?: Date | string | null;
};

/** 起点：这几个时间里最晚的那个（建项目、最后一行节点变更 / 转让 / 领取、客户上最后一次跟进），空的跳过 */
export function 超时起点(...时间: (Date | string | null | undefined)[]): Date {
  return 时间
    .filter((t): t is Date | string => !!t)
    .map((t) => new Date(t))
    .reduce((a, b) => (b > a ? b : a));
}

/** 哪天会被收回（YYYY-MM-DD）；不会被收回 = null */
export function 超时回收日(规则: 组织规则, p: 超时项目, 起点: Date | string): string | null {
  if (!规则.超时回收.开) return null;
  if (p.phase !== "线索" && p.phase !== "商机") return null;
  if (p.result || p.pooledAt) return null;
  const 天数 = 规则.超时回收.节点天数[p.node];
  if (!天数) return null;
  const 起 = dayjs(起点).startOf("day");
  let 日 = 起.add(天数, "day");
  if (p.nextStepAt) {
    const 下一步 = dayjs(p.nextStepAt).startOf("day");
    if (!下一步.isBefore(起)) {
      const 过完 = 下一步.add(1, "day");
      if (过完.isBefore(日)) 日 = 过完;
    }
  }
  return 日.format("YYYY-MM-DD");
}

/** 到了回收日就算超时 */
export function 已超时(回收日: string | null, 今: Date | string = new Date()): boolean {
  if (!回收日) return false;
  return dayjs(今).format("YYYY-MM-DD") >= 回收日;
}
