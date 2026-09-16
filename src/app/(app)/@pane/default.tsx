/**
 * 中栏槽位的兜底。[...slug]/page.tsx 匹配 (app) 下所有至少一段的路径。
 * 根路径 `/` 和并行槽位回落到 default 的那些导航状态归这里——没有它会 404。
 */
export default function PaneDefault() {
  return null;
}
