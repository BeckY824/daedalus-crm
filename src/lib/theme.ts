import type { ThemeConfig } from "antd";

/**
 * 视觉体系（v0.5）：往 Attio 那一路靠——白底、细线、小圆角、中性灰文字、
 * 品牌蓝只出现在主按钮、选中态和链接上；不用大色块、不用投影堆层次。
 * 密度也收紧一档：基准 14px，控件 34px。
 */
export const BRAND = "#2f6bff";
export const BRAND_DEEP = "#1a3f9e";

/** 侧边栏宽度，AppShell 与样式表共用 */
export const SIDER_WIDTH = 232;
export const SIDER_COLLAPSED_WIDTH = 64;

export const themeConfig: ThemeConfig = {
  token: {
    colorPrimary: BRAND,
    colorInfo: BRAND,
    colorLink: BRAND,
    colorSuccess: "#16a34a",
    colorWarning: "#d97706",
    colorError: "#dc2626",
    borderRadius: 6,
    borderRadiusLG: 10,
    borderRadiusSM: 4,
    fontSize: 14,
    fontSizeSM: 12,
    fontSizeLG: 16,
    fontSizeHeading4: 20,
    fontSizeHeading5: 16,
    controlHeight: 34,
    controlHeightSM: 28,
    controlHeightLG: 40,
    colorTextBase: "#111827",
    colorText: "#111827",
    colorTextSecondary: "#6b7280",
    colorTextTertiary: "#9ca3af",
    colorBorder: "#e5e7eb",
    colorBorderSecondary: "#eceef2",
    colorBgLayout: "#fafafa",
    colorBgContainer: "#ffffff",
    colorFillTertiary: "#f4f5f7",
    boxShadow: "0 1px 2px rgba(17, 24, 39, 0.04)",
    boxShadowSecondary: "0 8px 24px rgba(17, 24, 39, 0.08)",
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "SF Pro SC", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif',
  },
  components: {
    Layout: {
      siderBg: "#fbfbfc",
      bodyBg: "#fafafa",
      headerBg: "#ffffff",
      headerHeight: 52,
    },
    Menu: {
      itemBg: "transparent",
      subMenuItemBg: "transparent",
      itemColor: "#4b5563",
      itemHoverBg: "#f0f1f4",
      itemHoverColor: "#111827",
      itemSelectedBg: "#e9eefb",
      itemSelectedColor: "#1f3fbf",
      itemMarginInline: 10,
      itemMarginBlock: 2,
      itemHeight: 34,
      itemBorderRadius: 6,
      iconSize: 15,
      fontSize: 14,
      collapsedIconSize: 16,
    },
    Card: {
      borderRadiusLG: 10,
      paddingLG: 18,
      headerHeight: 46,
      headerFontSize: 14,
      colorBorderSecondary: "#e5e7eb",
      boxShadowTertiary: "none",
    },
    Table: {
      headerBg: "#fafafa",
      headerColor: "#6b7280",
      headerSplitColor: "transparent",
      rowHoverBg: "#f7f8fa",
      borderColor: "#eceef2",
      cellPaddingBlock: 12,
      cellPaddingInline: 14,
      cellPaddingBlockMD: 10,
      cellPaddingInlineMD: 14,
      cellPaddingBlockSM: 8,
      cellPaddingInlineSM: 12,
      fontSize: 13.5,
      headerBorderRadius: 8,
    },
    Button: {
      primaryShadow: "none",
      defaultShadow: "none",
      dangerShadow: "none",
      fontWeight: 500,
      defaultBorderColor: "#e5e7eb",
      defaultHoverBorderColor: "#cfd4dc",
      defaultHoverColor: "#111827",
    },
    Input: { activeShadow: "0 0 0 3px rgba(47, 107, 255, 0.12)" },
    Select: { optionSelectedBg: "#e9eefb" },
    Statistic: { contentFontSize: 26, titleFontSize: 13 },
    Tabs: { titleFontSize: 14, horizontalItemPadding: "10px 0", inkBarColor: "#111827", itemSelectedColor: "#111827", itemHoverColor: "#111827" },
    Segmented: { trackPadding: 2, trackBg: "#f0f1f4" },
    Tag: { fontSizeSM: 12, borderRadiusSM: 999 },
    Modal: { titleFontSize: 16, borderRadiusLG: 12 },
    Form: { labelFontSize: 13, verticalLabelPadding: "0 0 4px", labelColor: "#6b7280" },
    Breadcrumb: { fontSize: 13 },
    Dropdown: { borderRadiusLG: 10 },
    Alert: { borderRadiusLG: 8 },
  },
};
