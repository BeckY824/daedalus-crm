/**
 * 企业版「后台设置谁能改」（2026-10-26，清单 ② B2 第 6 条）：七样后台设置（10-26 加阶段规则）各由哪几类人改。
 *
 * 默认就是清单里的默认建议，对方逐行确认前先这么跑；定了在设置 → 组织架构 →「后台设置谁能改」里勾，
 * 存 Setting `enterprise.edit_perm`：{ 设置项: 能改的人[] }，没存的项 = 默认。
 * - 老板（账号管理员）每一项都能改，不受这张表管，免得把自己锁在外面。
 * - 「直属上级」「虚线上级」只对线索配额有意义：给自己的下属设。
 * 纯数据和纯函数，客户端组件也 import；读库的在 edit-perm.ts。
 */
import { 直属上级of, 虚线上级of, 管理员类别of, type 组织, type 管理员类别 } from "./org-core";

export type 能改的人 = 管理员类别 | "直属上级" | "虚线上级";

const 三类: readonly 能改的人[] = ["销售管理", "市场管理", "总管理员"];

export const 设置项 = {
  节点时限: { 名: "各节点时限（超时回收用）", 可选: 三类, 默认: ["销售管理", "市场管理", "总管理员"] },
  必填字段: { 名: "每个节点的必填字段（节点推进）", 可选: 三类, 默认: ["总管理员"] },
  线索配额: { 名: "线索分配配额", 可选: ["直属上级", "虚线上级", ...三类], 默认: ["直属上级", "虚线上级"] },
  持有上限: { 名: "公海持有上限", 可选: 三类, 默认: ["销售管理", "总管理员"] },
  字典: { 名: "异常类别、组员角色字典", 可选: 三类, 默认: ["总管理员"] },
  字段权限: { 名: "字段权限表", 可选: 三类, 默认: ["总管理员"] },
  阶段规则: { 名: "阶段出口叫法、往前推权限（负责人可推 / 仅上级推）", 可选: 三类, 默认: ["销售管理", "总管理员"] },
} as const satisfies Record<string, { 名: string; 可选: readonly 能改的人[]; 默认: readonly 能改的人[] }>;
export type 设置项名 = keyof typeof 设置项;
export const 设置项们 = Object.keys(设置项) as 设置项名[];

export type 改权限配置 = Partial<Record<设置项名, 能改的人[]>>;
export const 改权限key = "enterprise.edit_perm";

/** 存的、交来的配置都过一遍：不认识的项丢掉，每项只留这一项可选的人，按可选的顺序排；空数组 = 只有老板 */
export function 规整改权限(x: unknown): 改权限配置 {
  const out: 改权限配置 = {};
  if (!x || typeof x !== "object") return out;
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (!Object.hasOwn(设置项, k) || !Array.isArray(v)) continue;
    const 项 = k as 设置项名;
    const 可选: readonly 能改的人[] = 设置项[项].可选;
    out[项] = 可选.filter((p) => v.includes(p));
  }
  return out;
}

/** 这一项现在由谁改（不含老板） */
export function 谁能改(配置: 改权限配置, 项: 设置项名): readonly 能改的人[] {
  return 配置[项] ?? 设置项[项].默认;
}

/**
 * 我能不能改这一项。目标 = 线索配额给谁设（看他是不是我的直属 / 虚线下属）；别的项不用给。
 * 只管企业版：不是企业版的地方别调它，照原来的「只有老板」走。
 */
export function 能改设置(org: 组织, 我: { id: string; role: string }, 项: 设置项名, 配置: 改权限配置, 目标?: string): boolean {
  if (我.role === "ADMIN") return true;
  const 谁 = 谁能改(配置, 项);
  const 类 = 管理员类别of(org, 我.id);
  if (类 && 谁.includes(类)) return true;
  if (!目标) return false;
  return (谁.includes("直属上级") && 直属上级of(org, 目标) === 我.id) || (谁.includes("虚线上级") && 虚线上级of(org, 目标) === 我.id);
}

/** 「只有老板、销售管理、总管理员能改」这样的一句，界面和报错共用 */
export function 谁能改的话(配置: 改权限配置, 项: 设置项名): string {
  return `只有${["老板", ...谁能改(配置, 项)].join("、")}能改`;
}
