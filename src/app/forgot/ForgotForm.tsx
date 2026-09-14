"use client";

import { useState } from "react";
import Link from "next/link";
import { Form, Input, Button, Alert, Typography } from "antd";
import { LockOutlined, MailOutlined, SafetyOutlined } from "@ant-design/icons";
import Logo from "@/components/Logo";
import { 发送重置码, 重置密码 } from "./actions";

/**
 * 找回密码。两步，形状照着注册页来——同一件事在两个页面上长得一样，
 * 人才不用重新学：
 *
 *   第一步  只有一个邮箱框，点「发送验证码」
 *   第二步  验证码 + 新密码
 *
 * 两步都在同一个 Form 里，靠 display 切换而不是卸载：卸载会把填过的值丢掉，
 * 点「换一个」再回来就得重填。
 *
 * 成功之后不自动登录，回登录页让他用新密码登一次。
 * 一是这样他立刻确认了新密码真的能用，二是自动登录要在这里再处理一遍
 * 「这个账号有几个工作区、一个都没有怎么办」，那是登录动作的职责。
 */
const 倒计时秒 = 60;

export default function ForgotForm() {
  const [form] = Form.useForm();
  const [步骤, set步骤] = useState<1 | 2>(1);
  const [邮箱, set邮箱] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [完成, set完成] = useState(false);

  function 开始倒计时() {
    setLeft(倒计时秒);
    const t = setInterval(() => {
      setLeft((n) => {
        if (n <= 1) clearInterval(t);
        return n - 1;
      });
    }, 1000);
  }

  async function 发码(target: string, 首次: boolean) {
    setSending(true);
    setError(null);
    const r = await 发送重置码(target);
    setSending(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (首次) {
      set邮箱(target);
      set步骤(2);
    }
    开始倒计时();
    /**
     * 说的是「如果这个邮箱注册过」，不是「已发送」。
     * 服务端对没注册过的邮箱也返回成功（否则这里就成了查号接口），
     * 文案得跟上，不然没注册过的人会一直等。
     */
    setHint(r.hint ?? `如果 ${target} 注册过，验证码已经发过去了，10 分钟内有效`);
  }

  async function 下一步() {
    const v = await form.validateFields(["target"]).catch(() => null);
    if (!v) return;
    await 发码(String(v.target).trim(), true);
  }

  async function onFinish(v: { code: string; password: string }) {
    setLoading(true);
    setError(null);
    const r = await 重置密码({ target: 邮箱, code: v.code, password: v.password });
    setLoading(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    set完成(true);
  }

  if (完成) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div className="login-mark">
              <Logo size={30} />
            </div>
            <Typography.Title level={4} style={{ margin: 0, letterSpacing: -0.4 }}>
              密码已经改好了
            </Typography.Title>
          </div>
          <Alert
            type="success"
            showIcon
            style={{ marginBottom: 16 }}
            title="其他设备上的登录状态已经作废，都要用新密码重新登录。"
          />
          <Link href="/login">
            <Button type="primary" size="large" block>
              去登录
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div className="login-mark">
            <Logo size={30} />
          </div>
          <Typography.Title level={4} style={{ margin: 0, letterSpacing: -0.4 }}>
            找回密码
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            用注册时的邮箱收一个验证码，就能设新密码
          </Typography.Text>
        </div>

        {error && <Alert type="error" showIcon style={{ marginBottom: 14 }} title={error} />}
        {hint && 步骤 === 2 && <Alert type="info" showIcon style={{ marginBottom: 14 }} title={hint} />}

        <Form form={form} layout="vertical" onFinish={onFinish} requiredMark={false} disabled={loading}>
          {/* ---------- 第一步：只有邮箱 ---------- */}
          <div style={{ display: 步骤 === 1 ? "block" : "none" }}>
            <Form.Item
              name="target"
              rules={[
                { required: true, message: "请填写邮箱" },
                { type: "email", message: "这个邮箱看起来不对" },
              ]}
            >
              <Input
                size="large"
                prefix={<MailOutlined />}
                placeholder="注册时用的邮箱"
                autoComplete="email"
                onPressEnter={(e) => {
                  e.preventDefault();
                  下一步();
                }}
              />
            </Form.Item>
            <Button type="primary" size="large" block loading={sending} onClick={下一步}>
              发送验证码
            </Button>
          </div>

          {/* ---------- 第二步：验证码 + 新密码 ---------- */}
          <div style={{ display: 步骤 === 2 ? "block" : "none" }}>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 14 }}>
              {邮箱}
              <a
                style={{ marginLeft: 8 }}
                onClick={() => {
                  set步骤(1);
                  setError(null);
                  setHint(null);
                }}
              >
                换一个
              </a>
            </div>

            <Form.Item name="code" rules={[{ required: true, message: "请填写验证码" }]}>
              <Input
                size="large"
                prefix={<SafetyOutlined />}
                placeholder="邮件里的 6 位验证码"
                maxLength={6}
                inputMode="numeric"
                suffix={
                  <Button type="link" size="small" onClick={() => 发码(邮箱, false)} loading={sending} disabled={left > 0}>
                    {left > 0 ? `${left} 秒后重发` : "重发"}
                  </Button>
                }
              />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true, message: "请设置新密码" }]} extra="至少 8 位，含字母和数字">
              <Input.Password size="large" prefix={<LockOutlined />} placeholder="设置新密码" autoComplete="new-password" />
            </Form.Item>

            <Button type="primary" size="large" htmlType="submit" block loading={loading}>
              设置新密码
            </Button>
          </div>
        </Form>

        <div style={{ textAlign: "center", marginTop: 16, fontSize: 13 }}>
          想起来了？<Link href="/login">去登录</Link>
        </div>
      </div>
    </div>
  );
}
