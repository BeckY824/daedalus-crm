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

/*
  像素版的标（2026-10-02，用户要的「像素风的我们的 logo」，登录页左边那一块用）。
  同一个图形按 22 → 12 格缩：方框是一圈像素、四角各缺一格当圆角，台阶从 (3,9) 上到 (3,6)、
  横到 (6,6)、再上到 (6,3)、横到 (9,3)，末端那个点是 2×2。颜色和上面那份一样。
*/
const 框 = "#0B1B33";
const 线 = "#1554E8";
function 像素格(): [number, number, string][] {
  const 格: [number, number, string][] = [];
  for (let i = 1; i <= 10; i++) 格.push([i, 0, 框], [i, 11, 框], [0, i, 框], [11, i, 框]);
  for (let y = 6; y <= 9; y++) 格.push([3, y, 线]);
  for (let x = 4; x <= 6; x++) 格.push([x, 6, 线]);
  for (let y = 3; y <= 5; y++) 格.push([6, y, 线]);
  for (let x = 7; x <= 8; x++) 格.push([x, 3, 线]);
  格.push([8, 2, 线], [9, 2, 线], [9, 3, 线]);
  return 格;
}
const 像素 = 像素格();

export function PixelLogo({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" shapeRendering="crispEdges">
      {像素.map(([x, y, c]) => (
        <rect key={`${x},${y}`} x={x} y={y} width="1" height="1" fill={c} />
      ))}
    </svg>
  );
}
