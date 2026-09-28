/**
 * 金额输入框（antd InputNumber）的 formatter。商机、签约、赢单顺手登记签约三处共用。
 * **敲的时候不加 ¥ 也不加千分位，失焦后再格式化**；¥ 放在框外（InputNumber 的 prefix）。
 *
 * 2026-09-28 审查 S6，本机复现过：原来的 formatter 边敲边加「¥ 」和逗号，parser 又把空串
 * 读成 0——全选删掉后框里剩「¥ 0」、光标停在最前，接着敲 18000 得到的是 180,000。
 * 不是眼花，是真存成了十八万。userTyping 时原样返回人敲的字，就没有东西会在光标底下挪动；
 * 不给自定义 parser，空串就是空（null），不会凭空冒出一个 0。
 */
export function 金额格式(v: number | string | undefined, info: { userTyping: boolean; input: string }): string {
  if (info.userTyping) return info.input;
  if (v === undefined || v === null || v === "") return "";
  return `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

