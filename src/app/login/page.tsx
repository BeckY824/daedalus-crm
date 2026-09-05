"use client";

import { useState } from "react";
import { Form, Input, Button, Typography, Alert } from "antd";
import { UserOutlined, LockOutlined, CustomerServiceOutlined } from "@ant-design/icons";
import { login } from "./actions";

/** server action 迟迟不返回时的等待上限。链路正常时登录在 3 秒内完成。 */
const 请求超时毫秒 = 20000;
/** 跳转发起后仍停在本页的等待上限，超过就说明会话没真正建立。 */
const 跳转超时毫秒 = 15000;

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm();

  async function onFinish(values: { email: string; password: string }) {
    setLoading(true);
    setError(null);

    let res: Awaited<ReturnType<typeof login>>;
    try {
      /**
       * 必须带超时。server action 是一个普通的 POST，网络层把它挂住时
       * （代理、QUIC 回退失败、服务器无响应都会）这个 await 永远不会 settle，
       * 按钮就会无限转圈且不给任何提示——用户只能看到「一直在加载」。
       */
      res = await Promise.race([
        login(values.email, values.password),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 请求超时毫秒),
        ),
      ]);
    } catch (e) {
      setError(
        e instanceof Error && e.message === "timeout"
          ? "服务器无响应，请检查网络连接后重试"
          : "登录请求失败，请检查网络连接后重试",
      );
      setLoading(false);
      return;
    }

    if (!res.ok) {
      setError(res.error);
      setLoading(false);
      return;
    }

    /**
     * 用整页跳转，不用 router.push。
     * 软导航只拉 RSC 数据，会话 cookie 万一没生效（HTTP 下的 secure cookie、
     * 客户端拒收等），proxy.ts 会把请求弹回 /login——但当前组件不会重新挂载，
     * loading 永远停在 true，同样表现为无限转圈且零报错。
     * 整页跳转让浏览器重新走一遍完整请求，成败都看得见。
     * 这正是 @next/next/no-location-assign-relative-destination 要拦的写法，
     * 但登录是会话状态的变更点，此处硬跳转是有意的，故就地豁免。
     */
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/dashboard");

    // 跳转没能真正离开本页时的兜底提示（页面一旦卸载，这个定时器随之消失）
    setTimeout(() => {
      setError("登录成功但页面未能跳转，请刷新重试；若反复出现请联系管理员");
      setLoading(false);
    }, 跳转超时毫秒);
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              background: "#1668dc",
              color: "#fff",
              display: "grid",
              placeItems: "center",
              fontSize: 26,
              margin: "0 auto 14px",
              boxShadow: "0 8px 20px rgba(22,104,220,.3)",
            }}
          >
            <CustomerServiceOutlined />
          </div>
          <Typography.Title level={3} style={{ margin: 0, letterSpacing: -0.5 }}>
            CRM 客户管理系统
          </Typography.Title>
          <Typography.Text type="secondary">客户全周期管理，让销售更高效</Typography.Text>
        </div>

        {error && <Alert type="error" title={error} showIcon style={{ marginBottom: 16 }} />}

        <Form form={form} layout="vertical" onFinish={onFinish} size="large" requiredMark={false}>
          <Form.Item name="email" rules={[{ required: true, message: "请输入用户名" }]}>
            <Input prefix={<UserOutlined style={{ color: "#94a3b8" }} />} placeholder="用户名" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password prefix={<LockOutlined style={{ color: "#94a3b8" }} />} placeholder="登录密码" autoComplete="current-password" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 8 }}>
            <Button type="primary" htmlType="submit" block loading={loading}>
              登 录
            </Button>
          </Form.Item>
        </Form>

      </div>
    </div>
  );
}
