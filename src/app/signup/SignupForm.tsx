"use client";

import { useState } from "react";
import Link from "next/link";
import { Form, Input, Button, Alert, Typography, Checkbox } from "antd";
import { UserOutlined, LockOutlined, MobileOutlined, TeamOutlined, SafetyOutlined, GiftOutlined } from "@ant-design/icons";
import Logo from "@/components/Logo";
import { requestCode, signup } from "./actions";

/**
 * 注册：一屏填完，拿到一个试用 7 天的工作区。
 *
 * 只有托管版会挂这个页面；自部署版走的是管理员建账号，服务端动作里已经拦住。
 * 必填只有五个——每多一个字段就少一批人填完。邀请码可选，折在最下面。
 */
const 倒计时秒 = 60;

export default function SignupForm({ 注册赠送 }: { 注册赠送: number }) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  function 开始倒计时() {
    setLeft(倒计时秒);
    const t = setInterval(() => {
      setLeft((n) => {
        if (n <= 1) clearInterval(t);
        return n - 1;
      });
    }, 1000);
  }

  async function onSendCode() {
    const target = form.getFieldValue("target");
    if (!target) {
      setError("请先填手机号或邮箱");
      return;
    }
    setSending(true);
    setError(null);
    setHint(null);
    const r = await requestCode(target);
    setSending(false);
    if (r.ok) {
      开始倒计时();
      setHint(r.hint ?? "验证码已发送，10 分钟内有效");
    } else setError(r.error);
  }

  async function onFinish(v: { target: string; code: string; password: string; name: string; workspace: string; invite?: string; agreed?: boolean }) {
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
            7 天全功能，送 {注册赠送} 次 AI 对话，不用信用卡
          </Typography.Text>
        </div>

        {error && <Alert type="error" showIcon style={{ marginBottom: 14 }} title={error} />}
        {hint && <Alert type="info" showIcon style={{ marginBottom: 14 }} title={hint} />}

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
          <Form.Item name="code" rules={[{ required: true, message: "请填写验证码" }]}>
            <Input
              size="large"
              prefix={<SafetyOutlined />}
              placeholder="验证码"
              maxLength={6}
              inputMode="numeric"
              suffix={
                <Button type="link" size="small" onClick={onSendCode} loading={sending} disabled={left > 0}>
                  {left > 0 ? `${left} 秒后重发` : "获取验证码"}
                </Button>
              }
            />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: "请设置密码" }]} extra="至少 8 位，含字母和数字">
            <Input.Password size="large" prefix={<LockOutlined />} placeholder="设置密码" autoComplete="new-password" />
          </Form.Item>
          {/* 可选：预约演示后我们发的邀请码，填了多送 AI 次数。没有也能注册 */}
          <Form.Item name="invite">
            <Input size="large" prefix={<GiftOutlined />} placeholder="邀请码（可选，有就多送 AI 次数）" maxLength={16} autoCapitalize="characters" />
          </Form.Item>
          <Form.Item
            name="agreed"
            valuePropName="checked"
            rules={[{ validator: (_, v) => (v ? Promise.resolve() : Promise.reject(new Error("请先阅读并同意用户协议和隐私政策"))) }]}
            style={{ marginBottom: 16 }}
          >
            <Checkbox>
              <span style={{ fontSize: 13 }}>
                我已阅读并同意
                <Link href="/terms" target="_blank">
                  用户协议
                </Link>
                和
                <Link href="/privacy" target="_blank">
                  隐私政策
                </Link>
              </span>
            </Checkbox>
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
