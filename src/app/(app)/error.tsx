"use client";

import StatePage from "@/components/StatePage";
import { 决定错误展示 } from "@/lib/error-display";

/**
 * 应用内错误页。判断逻辑在 @/lib/error-display 里，这里只负责渲染——
 * 那边是纯函数，能被测试直接 import，不必靠读源码来「验证」。
 *
 * 和 404、空状态用同一套外观（components/StatePage）：三种「没有正文」的状态
 * 长一个样，说的也是同样三件事——发生了什么、为什么、接下来做什么。
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const 展示 = 决定错误展示(error, process.env.NODE_ENV === "development");

  if (展示.类型 === "未登录") {
    return (
      <StatePage
        标题="登录已过期"
        说明="这一页要登录才能看，而你这次的登录状态已经过期了——重新登录一次就能接着用，数据不受影响。"
        动作={{ label: "重新登录", href: "/login" }}
      />
    );
  }

  return (
    <StatePage
      标题="这一页没能打开"
      说明={
        展示.类型 === "原文"
          ? 展示.文本
          : "多半是一次偶发的失败（网络断了一下、或者服务端这次没答上来）。先重试；还不行就整页重新加载。"
      }
      动作={{ label: "重试", onClick: reset }}
      次动作={{ label: "重新加载", onClick: () => window.location.reload() }}
      附注={
        展示.类型 === "编号" && 展示.digest ? (
          <>一直不行的话，把这个编号发给管理员：<code>{展示.digest}</code></>
        ) : null
      }
    />
  );
}
