import type { ThemeConfig } from "antd";

/** 与设计稿一致的品牌蓝 */
export const BRAND = "#1668dc";
export const BRAND_DEEP = "#0f2c5c";

/** 侧边栏宽度，AppShell 与样式表共用 */
export const SIDER_WIDTH = 248;
export const SIDER_COLLAPSED_WIDTH = 80;

export const themeConfig: ThemeConfig = {
  token: {
    colorPrimary: BRAND,
    colorInfo: BRAND,
    borderRadius: 8,
    // 基准字号整体上调一档：14 → 16，其余尺寸随之放大
    fontSize: 16,
    fontSizeSM: 14,
    fontSizeLG: 18,
    fontSizeHeading4: 22,
    fontSizeHeading5: 18,
    controlHeight: 38,
    controlHeightSM: 30,
    controlHeightLG: 46,
    colorTextBase: "#1c2434",
    colorBgLayout: "#f2f6fc",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  components: {
    Layout: {
      siderBg: "#0d2645",
      bodyBg: "#f2f6fc",
      headerBg: "#ffffff",
      headerHeight: 68,
    },
    Menu: {
      darkItemBg: "#0d2645",
      darkSubMenuItemBg: "#0a1f38",
      darkItemSelectedBg: BRAND,
      darkItemHoverBg: "#153458",
      darkItemColor: "#c3d3e8",
      darkItemSelectedColor: "#ffffff",
      itemMarginInline: 12,
      itemHeight: 48,
      itemBorderRadius: 8,
      iconSize: 18,
      fontSize: 15,
    },
    Card: {
      borderRadiusLG: 14,
      paddingLG: 22,
      headerHeight: 56,
      headerFontSize: 17,
    },
    Table: {
      headerBg: "#f7fafd",
      headerColor: "#64748b",
      rowHoverBg: "#f5f9ff",
      borderColor: "#eef2f7",
      // 各尺寸档位的内边距要分别设：表格统一用 size="middle"，对应 *MD 这组 token
      cellPaddingBlock: 17,
      cellPaddingInline: 18,
      cellPaddingBlockMD: 15,
      cellPaddingInlineMD: 16,
      cellPaddingBlockSM: 11,
      cellPaddingInlineSM: 12,
      fontSize: 15,
    },
    Statistic: {
      contentFontSize: 30,
      titleFontSize: 15,
    },
    Tabs: {
      titleFontSize: 16,
      horizontalItemPadding: "14px 0",
    },
    Segmented: {
      trackPadding: 3,
    },
    Tag: {
      fontSizeSM: 13,
    },
    Modal: {
      titleFontSize: 18,
    },
    Form: {
      labelFontSize: 15,
      verticalLabelPadding: "0 0 6px",
    },
    Breadcrumb: {
      fontSize: 15,
    },
  },
};
