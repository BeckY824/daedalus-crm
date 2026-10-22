"use client";

import { useCallback } from "react";
import { App } from "antd";

/**
 * 复制到剪贴板。原来十处各写一份，一半没接失败：没授权、窗口没焦点、非 https 时
 * writeText 会拒绝，人点了没反应，控制台多一条未处理的报错。
 */

export const 复制失败文案 = "复制不了，请手动选中复制";

/** 写进剪贴板，成了回 true；失败不抛（navigator.clipboard 不存在也算失败） */
export async function 复制文字(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 复制并提示一句：成了说 成功，不成说 失败（各处可以给自己的说法）。函数引用稳定，可以放进依赖数组 */
export function useCopy() {
  const { message } = App.useApp();
  return useCallback(async (text: string, 成功: string, 失败 = 复制失败文案) => {
    const ok = await 复制文字(text);
    if (ok) message.success(成功);
    else message.error(失败);
    return ok;
  }, [message]);
}
