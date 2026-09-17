"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Form, Input, Button, Typography, Alert } from "antd";
import { UserOutlined, LockOutlined } from "@ant-design/icons";
import Logo from "@/components/Logo";
import { login, 桌面端登录 } from "./actions";

/** server action 迟迟不返回时的等待上限。链路正常时登录在 3 秒内完成。 */
const 请求超时毫秒 = 20000;
/** 跳转发起后仍停在本页的等待上限，超过就说明会话没真正建立。 */
const 跳转超时毫秒 = 15000;

/**
 * 登录表单。页面壳子在 page.tsx——那里是服务端组件，
 * 由它读运行时环境决定要不要画「忘记密码」：这个部署发不出信时，
 * 那个链接点进去只能看到「请联系我们」，不如不摆。
 *
 * 桌面端本地模式下这一张认的是**云端账号**（2026-09-17 起桌面端只有这一套身份）：
 * 提交走 桌面端登录()，它把账号密码交给云端换一枚设备令牌再签本机会话。
 * 注册开浏览器去网页办（那条路开出来的账号网页和桌面端都认），找回密码在应用内走。
 */
export default function LoginForm({
  可找回密码,
  用邮箱,
  桌面端 = false,
  可注册 = false,
  注册地址,
  提示,
}: {
  可找回密码: boolean;
  用邮箱: boolean;
  /** 桌面端本地模式：认的是云端账号，见上 */
  桌面端?: boolean;
  /** 桌面端：云端还收不收新注册。收就画一条开浏览器的链接 */
  可注册?: boolean;
  注册地址?: string;
  /** 为什么会站在这一页——比如令牌在别处被吊销了。有就先说清，再让人登 */
  提示?: string;
}) {
  /** 托管版和桌面端的账号是邮箱（或手机号），自部署是管理员建的登录名。见 page.tsx */
  const 账号名 = 桌面端 ? "邮箱或手机号" : 用邮箱 ? "邮箱" : "用户名";
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm();
  /**
   * 登录页的动效只有三下，多一下都不加：
   *   进场——卡片托一下（8px）、标志比正文早 60ms，让人知道这一页刚画好，不是卡住了
   *   报错——错误条是撑开的，不是砸下来的；后面的输入框跟着让位，不会跳一下
   *   登录失败——卡片横向抖一下（3px，一个来回）。密码错了这件事，看见比读见快
   * 系统开了「减弱动态效果」就全部按 0 处理（motion 的 useReducedMotion 读的是同一个开关）。
   */
  const 少动 = useReducedMotion();
  const [抖, set抖] = useState(0);
  const 报错 = (msg: string) => {
    setError(msg);
    set抖((n) => n + 1);
  };

  async function onFinish(values: { email: string; password: string }) {
    setLoading(true);
    setError(null);

    let res: Awaited<ReturnType<typeof login>>;
    try {
      /**
       * 必须带超时。server action 是一个普通的 POST，网络层把它挂住时
       * （代理、QUIC 回退失败、服务器无响应都会）这个 await 永远不会 settle，
       * 按钮就会无限转圈且不给任何提示——用户只能看到「一直在加载」。
       * 桌面端那条路自己还要去问一次云端，云端那边另有 20 秒超时，所以这里放宽到两倍。
       */
      res = await Promise.race([
        桌面端 ? 桌面端登录(values.email, values.password) : login(values.email, values.password),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 请求超时毫秒 * (桌面端 ? 2 : 1))),
      ]);
    } catch (e) {
      报错(
        e instanceof Error && e.message === "timeout"
          ? "服务器无响应，请检查网络连接后重试"
          : "登录请求失败，请检查网络连接后重试",
      );
      setLoading(false);
      return;
    }

    if (!res.ok) {
      报错(res.error);
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
      报错("登录成功但页面未能跳转，请刷新重试；若反复出现请联系管理员");
      setLoading(false);
    }, 跳转超时毫秒);
  }

  const 时长 = (t: number) => (少动 ? 0 : t);

  return (
    <div className="login-shell">
      <motion.div
        className="login-card"
        initial={{ opacity: 0, y: 少动 ? 0 : 8 }}
        animate={{ opacity: 1, y: 0, x: 抖 && !少动 ? [0, -3, 3, -2, 2, 0] : 0 }}
        transition={{
          opacity: { duration: 时长(0.28), ease: "easeOut" },
          y: { duration: 时长(0.28), ease: "easeOut" },
          x: { duration: 时长(0.25) },
        }}
      >
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <motion.div
            className="login-mark"
            initial={{ opacity: 0, scale: 少动 ? 1 : 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 时长(0.3), ease: "easeOut" }}
          >
            <Logo size={30} />
          </motion.div>
          <Typography.Title level={4} style={{ margin: 0, letterSpacing: -0.4 }}>
            Daedalus CRM
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {桌面端 ? "登录云端账号。数据只在这台机器上，账号只用来记 AI 次数。" : "下一代 CRM，跑在你自己的机器上。"}
          </Typography.Text>
        </div>

        {提示 && <Alert type="warning" showIcon style={{ marginBottom: 16, textAlign: "left" }} title={提示} />}
        {/* 错误条撑开、收起，而不是砸下来又消失：下面的输入框跟着让位，位置不会跳 */}
        <AnimatePresence initial={false}>
          {error && (
            <motion.div
              key="err"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 时长(0.2), ease: "easeOut" }}
              style={{ overflow: "hidden" }}
            >
              <Alert type="error" title={error} showIcon style={{ marginBottom: 16 }} />
            </motion.div>
          )}
        </AnimatePresence>

        <Form form={form} onFinish={onFinish} size="large" requiredMark={false}>
          <Form.Item name="email" rules={[{ required: true, message: `请输入${账号名}` }]}>
            <Input
              prefix={<UserOutlined style={{ color: "var(--text-muted)" }} />}
              placeholder={账号名}
              autoComplete={用邮箱 || 桌面端 ? "email" : "username"}
              inputMode={用邮箱 && !桌面端 ? "email" : undefined}
            />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password prefix={<LockOutlined style={{ color: "var(--text-muted)" }} />} placeholder="登录密码" autoComplete="current-password" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 8 }}>
            <Button type="primary" htmlType="submit" block loading={loading}>
              登 录
            </Button>
          </Form.Item>
        </Form>

        {(可找回密码 || (桌面端 && 可注册 && 注册地址)) && (
          <div style={{ display: "flex", justifyContent: "center", gap: 18, marginTop: 12, fontSize: 13 }}>
            {可找回密码 && <Link href="/forgot">忘记密码？</Link>}
            {/* 注册在网页上办：壳会把站外链接交给系统浏览器（main.js 的 setWindowOpenHandler） */}
            {桌面端 && 可注册 && 注册地址 && (
              <a href={注册地址} target="_blank" rel="noreferrer">
                注册新账号 ↗
              </a>
            )}
          </div>
        )}
      </motion.div>
    </div>
  );
}
