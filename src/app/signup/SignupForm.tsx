"use client";

import { useState } from "react";
import Link from "next/link";
import { Form, Input, Button, Alert, Typography, Checkbox } from "antd";
import { LockOutlined, MailOutlined, TeamOutlined, SafetyOutlined } from "@ant-design/icons";
import Logo from "@/components/Logo";
import { requestCode, signup } from "./actions";

/**
 * 注册。两步，照常见的 SaaS 做法：先证明邮箱是你的，再设密码。
 *
 *   第一步  只有一个邮箱框。点「发送验证码」，成功就进第二步
 *   第二步  验证码 + 密码 + 团队名称 + 条款
 *
 * 为什么第一步只留一个框：注册页每多一个字段就少一批人填完，而这一步真正要做的
 * 只有一件事——把码发出去。密码、团队名这些等他打开邮箱时再填，心理负担小得多。
 *
 * **只收邮箱，没有手机号。** 手机号要短信通道，而国内短信签名要域名备案，
 * 服务器在境外办不下来。摆一个填了就被拒的入口不如不摆。
 *
 * 不问姓名：它在「设置管理 → 用户管理」里随时能改，服务端先从邮箱前缀取一个。
 * 团队名称不一样，它决定了工作区的库文件名，建完改不了，所以必须问。
 *
 * **没有邀请码那一栏了。** 早先填了能多送 AI 次数，整套码 2026-09-15 下线：
 * 它让「怎么才能开号」有了好几个说法，而这件事应该只有一个说法。
 *
 * 两步都在同一个 Form 里，靠 display 切换而不是卸载——卸载会把已填的值丢掉，
 * 用户点「换一个」再回来就得重填。
 */
const 倒计时秒 = 60;

export default function SignupForm({ 注册赠送, 要验证码 }: { 注册赠送: number; 要验证码: boolean }) {
  const [form] = Form.useForm();
  const [步骤, set步骤] = useState<1 | 2>(1);
  const [邮箱, set邮箱] = useState("");
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

  /** 第一步：发码。没开验证码的部署直接进第二步 */
  async function 下一步() {
    const v = await form.validateFields(["target"]).catch(() => null);
    if (!v) return;
    const target = String(v.target).trim();
    if (!要验证码) {
      set邮箱(target);
      set步骤(2);
      return;
    }
    setSending(true);
    setError(null);
    const r = await requestCode(target);
    setSending(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    set邮箱(target);
    set步骤(2);
    开始倒计时();
    setHint(r.hint ?? `验证码已发到 ${target}，10 分钟内有效`);
  }

  async function 重发() {
    setSending(true);
    setError(null);
    const r = await requestCode(邮箱);
    setSending(false);
    if (r.ok) {
      开始倒计时();
      setHint(r.hint ?? "验证码已重新发送");
    } else setError(r.error);
  }

  async function onFinish(v: { code?: string; password: string; workspace: string; agreed?: boolean }) {
    setLoading(true);
    setError(null);
    const r = await signup({
      target: 邮箱,
      code: v.code,
      password: v.password,
      workspace: v.workspace,
      agreed: v.agreed,
    });
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
                placeholder="邮箱"
                autoComplete="email"
                onPressEnter={(e) => {
                  e.preventDefault();
                  下一步();
                }}
              />
            </Form.Item>
            <Button type="primary" size="large" block loading={sending} onClick={下一步}>
              {要验证码 ? "发送验证码" : "下一步"}
            </Button>
          </div>

          {/* ---------- 第二步：验证码 + 密码 + 团队名 ---------- */}
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

            {要验证码 && (
              <Form.Item name="code" rules={[{ required: true, message: "请填写验证码" }]}>
                <Input
                  size="large"
                  prefix={<SafetyOutlined />}
                  placeholder="邮件里的 6 位验证码"
                  maxLength={6}
                  inputMode="numeric"
                  suffix={
                    <Button type="link" size="small" onClick={重发} loading={sending} disabled={left > 0}>
                      {left > 0 ? `${left} 秒后重发` : "重发"}
                    </Button>
                  }
                />
              </Form.Item>
            )}
            <Form.Item name="password" rules={[{ required: true, message: "请设置密码" }]} extra="至少 8 位，含字母和数字">
              <Input.Password size="large" prefix={<LockOutlined />} placeholder="设置密码" autoComplete="new-password" />
            </Form.Item>
            <Form.Item name="workspace" rules={[{ required: true, message: "请填写团队名称" }]} extra="建好之后改不了，它决定你的工作区地址">
              <Input size="large" prefix={<TeamOutlined />} placeholder="团队名称，如「启明教育」" maxLength={40} />
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
          </div>
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
