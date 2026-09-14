"use client";

import { useState } from "react";
import { Button, Alert, Typography } from "antd";
import Logo from "@/components/Logo";
import { enterDemo, continueDemo } from "./actions";

/**
 * 演示区门口。原来这里要填一个「演示码」——运营台批量生成、一码一个浏览器。
 * 整套码 2026-09-15 下线之后这一页只剩一个按钮：它挡住的主要是**想看看的人**，
 * 而真要薅额度的人换个浏览器就绕过去了。按访客数 5 次 AI 那一半留着，
 * 那才是真正管住成本的东西（见 lib/tenant/demo-visitor.ts）。
 */
export default function DemoGate({ 来过 }: { 来过: { 还剩: number } | null }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function 进入(继续: boolean) {
    setLoading(true);
    setError(null);
    // 成功时 action 内部 redirect，不会回到这里；回来的只有失败
    const r = 继续 ? await continueDemo() : await enterDemo();
    setLoading(false);
    setError(r.error);
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div className="login-mark">
            <Logo size={30} />
          </div>
          <Typography.Title level={4} style={{ margin: 0, letterSpacing: -0.4 }}>
            在线演示
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            装满演示数据的工作区，随便点、随便改，每晚重置
          </Typography.Text>
        </div>

        {error && <Alert type="error" showIcon style={{ marginBottom: 14 }} title={error} />}

        {来过 && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 14 }}
            title={`这个浏览器进过演示区，AI 对话还剩 ${来过.还剩} 次`}
          />
        )}

        <Button type="primary" size="large" block loading={loading} onClick={() => 进入(Boolean(来过))}>
          {来过 ? "继续进入演示区" : "进入演示区"}
        </Button>

        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 14, marginBottom: 0, textAlign: "center" }}>
          演示区是所有访客共用的，AI 对话每个浏览器 5 次。
        </Typography.Paragraph>

        <div style={{ textAlign: "center", marginTop: 16, fontSize: 13, color: "#6b7280" }}>
          想要自己的工作区？<a href="/signup">免费注册一个</a>
        </div>
      </div>
    </div>
  );
}
