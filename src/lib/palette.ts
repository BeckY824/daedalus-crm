/**
 * 色板的 JS 镜像。**唯一**允许出现裸 hex 的地方（另一处是 globals.css 的 :root）。
 *
 * 样式表用 var(--xxx)；这里给那些认不了 CSS 变量的地方——antd 的主题对象、
 * echarts 的配置、SVG 属性、邮件 HTML。同一个颜色两处写，所以 tests/design-tokens.test.ts
 * 会把这里的每个值和 :root 对一遍：值对不上就红。这是第四份「必须一致的清单」
 * （前三份：打包白名单、工具 schema、过程条口语）。
 *
 * 2026-09-18 之前全站有 79 个不同的 hex、170 多处，同一个浅蓝四个版本、
 * 同一个"主蓝"两个版本（#2f6bff 和 antd 的 #1668dc 并存）。收敛之后：
 * 语义色一套、分类色八个、头像底色八个，再没有别的。
 */
export const palette = {
  brand: "#2f6bff",
  brandDeep: "#1a3f9e",
  brandBg: "#eef2ff",
  brandLine: "#c7d6ee",

  ink: "#111827",
  inkSoft: "#374151",
  textMuted: "#6b7280",
  textFaint: "#9ca3af",
  /** 压在深色底上的字 */
  onInk: "#ffffff",

  line: "#e5e7eb",
  lineSoft: "#eceef2",
  lineStrong: "#d1d5db",
  panel: "#ffffff",
  workbench: "#fafafa",
  hover: "#f0f1f4",
  rowHover: "#f7f8fa",

  success: "#16a34a", successText: "#15803d", successBg: "#f0fdf4", successLine: "#bbf7d0",
  warning: "#d97706", warningText: "#92400e", warningBg: "#fffbeb", warningLine: "#fde68a",
  danger: "#dc2626", dangerText: "#b91c1c", dangerBg: "#fef2f2", dangerLine: "#fecaca",
} as const;

/**
 * 分类色：给"彼此没有高低之分、只是不同"的东西——商机阶段、跟进类型、图表里并列的几条线。
 * 八个色相拉开，相邻的不撞。**不表示好坏**：好坏用上面的 success / warning / danger。
 */
export const categorical = {
  blue: "#2563eb",
  green: "#22c55e",
  yellow: "#eab308",
  orange: "#f97316",
  pink: "#ec4899",
  violet: "#8b5cf6",
  cyan: "#06b6d4",
  amber: "#f59e0b",
} as const;

/** 头像底色：八个淡色，按名字哈希选一个。字色一律 inkSoft */
export const avatarBg = ["#dbeafe", "#dcfce7", "#fef3c7", "#fde2e2", "#ede9fe", "#e0f2fe", "#fce7f3", "#e2e8f0"] as const;

/** 给需要透明度的地方（图标底、进度条）：hex + 两位 alpha，别再手写 #xxxxxx1f */
export const alpha = (hex: string, a: number) => `${hex}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
