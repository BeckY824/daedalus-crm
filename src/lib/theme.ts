import type { ThemeConfig } from "antd";

/**
 * antd 这边的 token。
 *
 * 真正的一份 token 在 `src/app/globals.css` 的 `:root` 里——字号四级、十组颜色、
 * 间距圆角动效、骨架尺寸都在那儿。这里只是把同样的值喂给 antd，
 * 因为 antd 的组件样式是 CSS-in-JS 生成的，读不到 CSS 变量。
 * **两边的数必须一样**；改颜色改字号先改 globals.css，再回来对一遍。
 *
 * 早先这里还导出过 RAIL_WIDTH = 76 / PANE_WIDTH = 352，没有任何地方用，
 * 值也停在侧栏加宽之前——已经删掉，宽度只由 --rail-w / --pane-w 说了算。
 */
export const BRAND = "#2f6bff";

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
    /* 页面标题 22 / 区块标题 15，和 --fs-title / --fs-section 对齐 */
    fontSizeHeading4: 22,
    fontSizeHeading5: 15,
    controlHeight: 34,
    controlHeightSM: 28,
    controlHeightLG: 40,
    colorTextBase: "#111827",
    colorText: "#111827",
    colorTextSecondary: "#6b7280",
    /* Typography type="secondary" 走的是这个，不是 colorTextSecondary。
       派生值是 #9ca3af——跟进记录整列正文就是这么变成浅灰的。说明最浅到 #6b7280 */
    colorTextDescription: "#6b7280",
    /* --text-faint：placeholder、禁用、装饰。不许当正文 */
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
      headerFontSize: 15,
      colorBorderSecondary: "#e5e7eb",
      boxShadowTertiary: "none",
    },
    Table: {
      headerBg: "#fafafa",
      headerColor: "#6b7280",
      headerSplitColor: "transparent",
      rowHoverBg: "#f7f8fa",
      rowSelectedBg: "#eef2ff",
      rowSelectedHoverBg: "#e6ecff",
      borderColor: "#eceef2",
      cellPaddingBlock: 12,
      cellPaddingInline: 14,
      cellPaddingBlockMD: 10,
      cellPaddingInlineMD: 14,
      cellPaddingBlockSM: 8,
      cellPaddingInlineSM: 12,
      /* 表格正文就是正文，和别处一样 14。13.5 是上一版为了多塞一列凑出来的 */
      fontSize: 14,
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
