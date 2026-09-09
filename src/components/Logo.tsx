/** Daedalus.AI 的标：圆角方框里一条台阶式折线，末端一个点。与官网同一份图形 */
export default function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="20" height="20" rx="3.5" stroke="#0B1B33" strokeWidth="1.5" />
      <path d="M5.5 16.5V11H11V5.5H16.5" stroke="#1554E8" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16.5" cy="5.5" r="1.7" fill="#1554E8" />
    </svg>
  );
}
