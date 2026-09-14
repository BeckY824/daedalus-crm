"use client";

import { useState } from "react";
import Link from "next/link";
import { Form, Input, Button, Alert, Typography } from "antd";
import { UserOutlined, LockOutlined, MobileOutlined, TeamOutlined, SafetyOutlined } from "@ant-design/icons";
import Logo from "@/components/Logo";
import { signup } from "./actions";

/**
 * 注册：一屏填完，拿到一个试用 7 天的工作区。
 *
 * 只有托管版会挂这个页面；自部署版走的是管理员建账号，服务端动作里已经拦住。
 * 表单字段刻意只有五个——每多一个字段就少一批人填完。
 */

export default function SignupForm() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFinish(v: { target: string; code: string; password: string; name: string; workspace: string }) {
    setLoading(true);
    setError(null);
    const r = await signup(v);
    setLoading(false);
    if (r.ok) {
      // 整页跳转而不是 router.push，理由同登录页：软导航下会话没生效时
      // 会被 proxy 弹回来而组件不重新挂载，表现为无限转圈且零报错
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/dashboard");
    } else setError(r.error);
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div className="login-mark">
            <Logo size={30} />
          </div>
          <Typography.Title level={4} style={{ margin: 0, letterSpacing: -0.4 }}>
            开始免费试用
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            7 天全功能，不用信用卡
          </Typography.Text>
        </div>

        {error && <Alert type="error" showIcon style={{ marginBottom: 14 }} title={error} />}

        <Form form={form} layout="vertical" onFinish={onFinish} requiredMark={false} disabled={loading}>
          <Form.Item name="workspace" rules={[{ required: true, message: "请填写团队名称" }]}>
            <Input size="large" prefix={<TeamOutlined />} placeholder="团队名称，如「启明教育」" maxLength={40} />
          </Form.Item>
          <Form.Item name="name" rules={[{ required: true, message: "请填写你的姓名" }]}>
            <Input size="large" prefix={<UserOutlined />} placeholder="你的姓名" maxLength={20} />
          </Form.Item>
          <Form.Item name="target" rules={[{ required: true, message: "请填写手机号或邮箱" }]}>
            <Input size="large" prefix={<MobileOutlined />} placeholder="手机号或邮箱" autoComplete="username" />
          </Form.Item>
          {/* 激活码替代验证码：码本身就是授权凭证，不需要发码通道。没码的人到官网咨询页申请 */}
          <Form.Item name="code" rules={[{ required: true, message: "请填写激活码" }]} extra={<span>没有激活码？<a href="https://ai-daedalus.com/demo.html" target="_blank" rel="noopener">到这里申请</a></span>}>
            <Input size="large" prefix={<SafetyOutlined />} placeholder="激活码，如 AB3D-EF5G-HJ7K" maxLength={16} autoCapitalize="characters" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: "请设置密码" }]} extra="至少 8 位，含字母和数字">
            <Input.Password size="large" prefix={<LockOutlined />} placeholder="设置密码" autoComplete="new-password" />
          </Form.Item>

          <Button type="primary" size="large" htmlType="submit" block loading={loading}>
            创建工作区
          </Button>
        </Form>

        <div style={{ textAlign: "center", marginTop: 16, fontSize: 13 }}>
          已经有账号了？<Link href="/login">去登录</Link>
        </div>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 14, marginBottom: 0, textAlign: "center" }}>
          数据存在你自己的工作区里，我们不会拿它训练任何模型。
        </Typography.Paragraph>
      </div>
    </div>
  );
}
