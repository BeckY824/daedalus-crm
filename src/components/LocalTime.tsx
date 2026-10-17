"use client";

import { useCountryLocalTime } from "@/lib/country-time-client";

/**
 * 「对方当地 14:05」（2026-10-16 外贸基础）。客户详情的标签行、客户列表的国家那一格用。
 * 对方那边是夜里（22 点到早 7 点）就压暗一点、标上「夜里」：发消息、打电话前多想一下。
 * 认不出国家、和本机同一钟点、还在服务端时什么都不画
 */
export default function LocalTime({ country, 简短 = false, className }: { country: string | null | undefined; 简短?: boolean; className?: string }) {
  const t = useCountryLocalTime(country);
  if (!t) return null;
  const 字 = 简短 ? `${t.日差 ? `${t.日差} ` : ""}${t.时分}` : t.说法;
  return (
    <span
      className={`${className ?? ""}${t.夜里 ? " local-time-night" : ""}`.trim()}
      title={`按${country}首都所在时区（${t.时区}）算${t.夜里 ? "，对方现在是夜里" : ""}`}
      data-testid="local-time"
    >
      {字}
      {t.夜里 && <span className="local-time-tag">夜里</span>}
    </span>
  );
}
