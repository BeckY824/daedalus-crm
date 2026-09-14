"use client";

import { useState } from "react";
import { Form, Input, Button, Alert, Typography } from "antd";
import { SafetyOutlined } from "@ant-design/icons";
import Logo from "@/components/Logo";
import { enterDemo, continueDemo } from "./actions";

export default function DemoGate({ 已绑 }: { 已绑: { 还剩: number } | null }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function 进入(code?: string) {
    setLoading(true);
    setError(null);
    // 成功时 action 内部 redirect，不会回到这里；回来的只有失败
    const r = code === undefined ? await continueDemo() : await enterDemo(code);
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

        {已绑 ? (
          <>
            <Alert type="info" showIcon style={{ marginBottom: 14 }} title={`这个浏览器已经用过演示码，AI 对话还剩 ${已绑.还剩} 次`} />
            <Button type="primary" size="large" block loading={loading} onClick={() => 进入()}>
              继续进入演示区
            </Button>
          </>
        ) : (
          <Form layout="vertical" onFinish={(v: { code: string }) => 进入(v.code)}>
            <Form.Item
              name="code"
              rules={[{ required: true, message: "请填写演示码" }]}
              extra={
                <span>
                  一个演示码只能在一个浏览器里用，含 5 次 AI 对话。没有？
                  <a href="https://ai-daedalus.com/demo.html" target="_blank" rel="noopener">到这里申请</a>
                </span>
              }
            >
              <Input size="large" prefix={<SafetyOutlined />} placeholder="演示码，如 AB3D-EF5G-HJ7K" maxLength={16} autoCapitalize="characters" autoFocus />
            </Form.Item>
            <Button type="primary" size="large" block htmlType="submit" loading={loading}>
              进入演示区
            </Button>
          </Form>
        )}

        <div style={{ textAlign: "center", marginTop: 16, fontSize: 13, color: "#6b7280" }}>
          想要自己的工作区？<a href="/signup">用试用码开一个</a>
        </div>
      </div>
    </div>
  );
}
