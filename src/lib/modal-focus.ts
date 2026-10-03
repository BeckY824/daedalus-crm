/**
 * 表单弹框开好以后，光标放进第一格。用法：`<Modal afterOpenChange={聚焦首项} …>`
 *
 * 2026-10-03 走查：「手动录一位」打开后焦点落在右上角的关闭按钮上，人得先点一下「客户姓名」才能打字。
 * antd 6 的弹框在开场动画走完时把焦点交给框里第一个能聚焦的东西——那就是关闭按钮，
 * 所以在输入框上写 autoFocus 不管用（浏览器先给了它，动画一走完又被拿走）。
 * afterOpenChange 恰好在那之后触发，这时候再挪一次。
 *
 * 只挪「打字的格子」：下拉、勾选、单选不算第一格——光标落在一个下拉上，人还是要先点开它。
 * 焦点已经在正文里（动画那 200ms 里手快的人点了某一格、某个下拉）就不动，别把人正在用的东西抢走。
 */
const 格子 =
  ':is(input, textarea):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly]):not([role="combobox"])';

export function 聚焦首项(开了: boolean): void {
  if (!开了 || typeof document === "undefined") return;
  const 现在 = document.activeElement as HTMLElement | null;
  const 框 =
    现在?.closest<HTMLElement>(".ant-modal-container") ??
    [...document.querySelectorAll<HTMLElement>(".ant-modal-wrap")].filter((w) => w.style.display !== "none").pop()?.querySelector<HTMLElement>(".ant-modal-container") ??
    null;
  if (!框) return;
  // 人已经在正文里点了什么（打字格、下拉、勾选都算）就不动：动画那 200ms 里手快的人点开了一个下拉，
  // 这时把焦点拽回第一格，下拉当场就收了（e2e 就地建渠道那条实地撞到）。只在焦点还停在关闭按钮 / 框本身时才挪
  if (现在 && 框.contains(现在) && 现在.closest(".ant-modal-body")) return;
  框.querySelector<HTMLElement>(`.ant-modal-body ${格子}`)?.focus();
}
