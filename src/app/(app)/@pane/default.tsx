/**
 * 没有中栏的路由（看板、线索、渠道、联系人、复盘、账单…）落到这里，一个节点都不画。
 *
 * 并行槽位必须有 default.tsx：没有它，任何没建同名槽位页的路由都会 404。
 * 所以「哪些页有中栏」= @pane 下建了哪些页，别的自动没有。
 */
export default function PaneDefault() {
  return null;
}
