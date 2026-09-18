import type { ThemeConfig } from "antd";
import { palette, alpha } from "@/lib/palette";

/**
 * antd 这边的 token。
 *
 * 真正的一份 token 在 `src/app/globals.css` 的 `:root` 里——字号四级、十组颜色、
 * 间距圆角动效、骨架尺寸都在那儿。这里只是把同样的值喂给 antd，
 * 因为 antd 的组件样式是 CSS-in-JS 生成的，读不到 CSS 变量。
 * **两边的数必须一样**：颜色从 lib/palette.ts 取（tests/design-tokens.test.ts 会和 :root 对一遍），
 * 字号、圆角这些数字还是手抄——改了 globals.css 记得回来对。
 *
 * 早先这里还导出过 RAIL_WIDTH = 76 / PANE_WIDTH = 352，没有任何地方用，
 * 值也停在侧栏加宽之前——已经删掉，宽度只由 --rail-w / --pane-w 说了算。
 */
export const BRAND = palette.brand;

export const themeConfig: ThemeConfig = {
  token: {
    colorPrimary: BRAND,
    colorInfo: BRAND,
    colorLink: BRAND,
    colorSuccess: palette.success,
    colorWarning: palette.warning,
    colorError: palette.danger,
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
    colorTextBase: palette.ink,
    colorText: palette.ink,
    colorTextSecondary: palette.textMuted,
    /* Typography type="secondary" 走的是这个，不是 colorTextSecondary。
       派生值是 #9ca3af——跟进记录整列正文就是这么变成浅灰的。说明最浅到 #6b7280 */
    colorTextDescription: palette.textMuted,
    /* --text-faint：placeholder、禁用、装饰。不许当正文 */
    colorTextTertiary: palette.textFaint,
    colorBorder: palette.line,
    colorBorderSecondary: palette.lineSoft,
    colorBgLayout: palette.workbench,
    colorBgContainer: palette.panel,
    colorFillTertiary: palette.hover,
    boxShadow: "0 1px 2px rgba(17, 24, 39, 0.04)",
    boxShadowSecondary: "0 8px 24px rgba(17, 24, 39, 0.08)",
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "SF Pro SC", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif',
  },
  components: {
    Layout: {
      siderBg: palette.workbench,
      bodyBg: palette.workbench,
      headerBg: palette.panel,
      headerHeight: 52,
    },
    Menu: {
      itemBg: "transparent",
      subMenuItemBg: "transparent",
      itemColor: palette.inkSoft,
      itemHoverBg: palette.hover,
      itemHoverColor: palette.ink,
      itemSelectedBg: palette.brandBg,
      itemSelectedColor: palette.brandDeep,
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
      colorBorderSecondary: palette.line,
      boxShadowTertiary: "none",
    },
    Table: {
      headerBg: palette.workbench,
      headerColor: palette.textMuted,
      headerSplitColor: "transparent",
      rowHoverBg: palette.rowHover,
      rowSelectedBg: palette.brandBg,
      // 选中又悬停：比选中再深一档。没有单独的 token，用主色加透明度
      rowSelectedHoverBg: alpha(palette.brand, 0.14),
      borderColor: palette.lineSoft,
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
      defaultBorderColor: palette.line,
      defaultHoverBorderColor: palette.lineStrong,
      defaultHoverColor: palette.ink,
    },
    Input: { activeShadow: "0 0 0 3px rgba(47, 107, 255, 0.12)" },
    Select: { optionSelectedBg: palette.brandBg },
    Statistic: { contentFontSize: 26, titleFontSize: 13 },
    Tabs: { titleFontSize: 14, horizontalItemPadding: "10px 0", inkBarColor: palette.ink, itemSelectedColor: palette.ink, itemHoverColor: palette.ink },
    Segmented: { trackPadding: 2, trackBg: palette.hover },
    Tag: { fontSizeSM: 12, borderRadiusSM: 999 },
    Modal: { titleFontSize: 16, borderRadiusLG: 12 },
    Form: { labelFontSize: 13, verticalLabelPadding: "0 0 4px", labelColor: palette.textMuted },
    Breadcrumb: { fontSize: 13 },
    Dropdown: { borderRadiusLG: 10 },
    Alert: { borderRadiusLG: 8 },
  },
};
