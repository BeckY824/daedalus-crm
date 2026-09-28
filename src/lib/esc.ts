/**
 * 一次 Esc 该不该由「页面级」的处理器接（比如首页那句「Esc 打断正在跑的回答」）。
 *
 * Esc 的本分是关掉**最上面那一层**。2026-09-28 审查 M7：首页上关斜杠菜单、关 ⌘K 跳转单、
 * 关建议卡上的日期选择、甚至取消输入法里的拼音，都会顺手把底下正在答的那一问打断——
 * 那一问已经花了次数。所以下面几种情况一律让出去：
 *   - 已经有人处理过（defaultPrevented）
 *   - 正在输入法组字（isComposing；Safari 老版本只给 keyCode 229）
 *   - 按键发生在某个浮层里，或者页面上正开着浮层（下拉、日期、弹框、气泡、⌘K）
 *
 * 浮层判断在 window 的冒泡阶段做：这时各组件自己的「Esc 关掉」还没来得及重画，
 * 浮层仍在 DOM 里，看得到。
 */
export type 按键 = {
  key: string;
  defaultPrevented: boolean;
  isComposing?: boolean;
  keyCode?: number;
  target: EventTarget | null;
};

/** 开着就算「上面还有一层」的那几类浮层。antd 收起的浮层会挂 -hidden 类，不算 */
export const 浮层选择器 = [
  ".ant-select-dropdown:not(.ant-select-dropdown-hidden)",
  ".ant-picker-dropdown:not(.ant-picker-dropdown-hidden)",
  ".ant-dropdown:not(.ant-dropdown-hidden)",
  ".ant-popover:not(.ant-popover-hidden)",
  ".ant-modal-wrap",
  ".ant-drawer-open",
  ".cmdk",
].join(", ");

export function Esc归别人(e: 按键, 查: (sel: string) => boolean = (sel) => Boolean(document.querySelector(sel))): boolean {
  if (e.key !== "Escape") return true;
  if (e.defaultPrevented) return true;
  if (e.isComposing || e.keyCode === 229) return true;
  const t = e.target as { closest?: (s: string) => unknown } | null;
  if (t && typeof t.closest === "function" && t.closest(浮层选择器)) return true;
  return 查(浮层选择器);
}
