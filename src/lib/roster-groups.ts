/**
 * 记录页窄名单的「按跟进状态分组」（CustomerRoster.tsx），抽成纯函数好钉测试（2026-10-04 L-072）。
 *
 * 规矩只有一条：**一个人都不能从分组视图里消失**。分组时名单上没有别的入口，
 * 哪个人没进任何一组，用户就只能搜出来，会以为客户丢了。
 * - 预设状态按预设顺序排；
 * - 预设外的（老库里的、导入时自己填的）各自成组，按出现先后接在后面，组名就是它自己（dcb680f 修过，原来没测试）；
 * - 空串 / 只有空格 / null 归到「未填写」——原来空串自己成一组，组头一片空白，看着像渲染坏了；
 * - 前后带空格的按去掉空格后的认，「 跟进中」不另起一个看着一模一样的组。
 */
import { FOLLOW_STATUSES } from "./constants";

export const 未填写组 = "未填写";

export function 名单分组<T extends { followStatus: string | null }>(rows: T[]): { s: string; rows: T[] }[] {
  const 组名 = (r: T) => r.followStatus?.trim() || 未填写组;
  const 预设 = new Set<string>(FOLLOW_STATUSES);
  const 其余 = [...new Set(rows.map(组名).filter((s) => !预设.has(s)))];
  // 「未填写」放最后：它不是一种状态，是缺了状态
  const 顺序 = [...FOLLOW_STATUSES, ...其余.filter((s) => s !== 未填写组), ...(其余.includes(未填写组) ? [未填写组] : [])];
  return 顺序.map((s) => ({ s, rows: rows.filter((r) => 组名(r) === s) })).filter((g) => g.rows.length > 0);
}
