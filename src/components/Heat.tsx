import { 冷热 } from "@/lib/utils";

/**
 * 这两种状态的人本来就不用跟：签了的、丢了的，一个月没联系是常态。
 * 给他们亮一格「凉了」只是噪音，会把真正该跟的人淹掉，所以干脆不画。
 */
const 不用跟 = new Set(["已签约", "已流失"]);
export const 要看冷热 = (status?: string | null) => !status || !不用跟.has(status);

/**
 * 冷热信号条：四格，越满越热（刚跟过），空了就是凉了。规则见 lib/utils.ts 的 冷热。
 * 只是一个形，不带字；要字的地方自己在旁边写（列表里是「3 天前」，记录页头部是「3 天没跟」）。
 */
export default function Heat({ at, status }: { at: string | null | undefined; status?: string | null }) {
  // 不画，但把位置留着：一列里有的行有条、有的没有，后面的日期就对不齐了
  if (!要看冷热(status)) return <span className="heat heat-skip" aria-hidden="true" />;
  const { 格 } = 冷热(at);
  const 说 = 冷热说法(at);
  return (
    <span className="heat" data-l={格} role="img" aria-label={`冷热：${说}`} title={说}>
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

/** 记录页头部那一句 */
export function 冷热说法(at: string | null | undefined): string {
  const { 天 } = 冷热(at);
  return 天 === null ? "还没跟进过" : 天 === 0 ? "今天跟过" : `${天} 天没跟`;
}
