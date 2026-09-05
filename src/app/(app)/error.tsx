"use client";

import { Result, Button, Typography } from "antd";
import { 决定错误展示 } from "@/lib/error-display";

/**
 * 应用内错误页。判断逻辑在 @/lib/error-display 里，这里只负责渲染——
 * 那边是纯函数，能被测试直接 import，不必靠读源码来「验证」。
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const 展示 = 决定错误展示(error, process.env.NODE_ENV === "development");

  return (
    <Result
      status={展示.类型 === "未登录" ? "403" : "error"}
      title={展示.类型 === "未登录" ? "登录已过期" : "页面出错了"}
      subTitle={
        展示.类型 === "未登录" ? (
          "请重新登录后继续操作。"
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {展示.类型 === "原文" ? (
              展示.文本
            ) : (
              <>
                请重试；如果一直不行，把下面这个编号发给管理员。
                {展示.digest && (
                  <>
                    <br />
                    错误编号：<code>{展示.digest}</code>
                  </>
                )}
              </>
            )}
          </Typography.Text>
        )
      }
      extra={
        展示.类型 === "未登录" ? (
          <Button type="primary" href="/login">
            重新登录
          </Button>
        ) : (
          <Button type="primary" onClick={reset}>
            重试
          </Button>
        )
      }
    />
  );
}
