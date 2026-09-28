import { 冷热 } from "@/lib/utils";

/**
 * 冷热信号条：四格，越满越热（刚跟过），空了就是凉了。规则见 lib/utils.ts 的 冷热。
 * 只是一个形，不带字；要字的地方自己在旁边写（列表里是「3 天前」，记录页头部是「3 天没跟」）。
 */
export default function Heat({ at }: { at: string | null | undefined }) {
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
