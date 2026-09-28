"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * 列表页的筛选条件：本地留一份（输入框随打随显），查的时候写进地址栏、交给服务端重新取数。
 *
 * 条件放在地址栏里，所以刷新、前进后退、把网址发给同事都还是这一屏。
 * 客户、线索、商机、跟进四张列表页原来各写一遍一模一样的 apply / 重置 / 翻页，只差一个路径。
 * 加一张新列表页：服务端 page.tsx 从 searchParams 读条件，视图里用这个钩子就行。
 */
export function useUrlFilters<F extends Record<string, string>>(path: string, 初始: F) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [f, setF] = useState(初始);

  const 去 = (条件: Record<string, string | number>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(条件)) if (v) q.set(k, String(v));
    startTransition(() => router.push(q.size ? `${path}?${q}` : path));
  };

  return {
    f,
    setF,
    /** 服务端在取新的一页，表格据此转圈 */
    pending,
    /** 改几项条件并按新条件重查（回到第一页） */
    apply(next: Partial<F> = {}) {
      const merged = { ...f, ...next };
      setF(merged);
      去(merged);
    },
    /** 条件不动，只翻页 */
    翻页(page: number, pageSize: number) {
      去({ ...f, page, pageSize });
    },
    /** 清掉所有条件，回到全部 */
    reset() {
      setF(Object.fromEntries(Object.keys(f).map((k) => [k, ""])) as F);
      去({});
    },
  };
}
