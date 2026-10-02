"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Form, Input, Button, Typography, Alert } from "antd";
import { UserOutlined, LockOutlined } from "@ant-design/icons";
import Logo from "@/components/Logo";
import { login, 桌面端登录 } from "./actions";
import { 登录之后 } from "./after-login";
import Rise from "@/components/Rise";
import { useMotionTheme } from "@/components/MotionTheme";

/** server action 迟迟不返回时的等待上限。链路正常时登录在 3 秒内完成。 */
const 请求超时毫秒 = 20000;

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
  const { 曲线, 时长 } = useMotionTheme();
  /** 托管版和桌面端的账号是邮箱（或手机号），自部署是管理员建的登录名。见 page.tsx */
  const 账号名 = 桌面端 ? "邮箱或手机号" : 用邮箱 ? "邮箱" : "用户名";
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm();
  /**
   * 登录页的动效只有三下，多一下都不加：
   *   进场——卡片托一下（8px），里面按 标志 → 表单 → 底下那排链接 排队（Rise，一档 70ms）。
   *         人的眼睛读得出这个先后，但读不出它在等；这是整个产品的第一印象，
   *         它要说的是「这一页刚画好」，不是「这一页在加载」
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

    await 登录之后(res, (msg) => {
      报错(msg);
      setLoading(false);
    });
  }

  const 秒 = (t: number) => (少动 ? 0 : t);

  return (
    <div className="login-shell">
      <motion.div
        className="login-card"
        initial={{ opacity: 0, y: 少动 ? 0 : 8 }}
        animate={{ opacity: 1, y: 0, x: 抖 && !少动 ? [0, -3, 3, -2, 2, 0] : 0 }}
        transition={{
          opacity: { duration: 秒(时长.morph), ease: 曲线.ease },
          y: { duration: 秒(时长.morph), ease: 曲线.ease },
          x: { duration: 秒(时长.morph), ease: 曲线.ease },
        }}
      >
        <Rise 第几个={0} style={{ textAlign: "center", marginBottom: 28 }}>
          {/* 标志是**落定**的：从 0.8 长到 1，带一点点过冲（--ease-spring 那条曲线）。
              它是这一页第一个画完的东西，也是唯一一个允许"弹"的——底下的表单一律平静地上浮 */}
          <motion.div
            className="login-mark"
            initial={{ opacity: 0, scale: 少动 ? 1 : 0.8, y: 少动 ? 0 : -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 秒(时长.morph), ease: 曲线.spring }}
          >
            <Logo size={30} />
          </motion.div>
          <Typography.Title level={4} style={{ margin: 0, letterSpacing: -0.4 }}>
            Daedalus CRM
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {桌面端 ? "登录云端账号。数据只在这台机器上，账号只用来记 AI 次数。" : "下一代 CRM，跑在你自己的机器上。"}
          </Typography.Text>
        </Rise>

        {提示 && <Alert type="warning" showIcon style={{ marginBottom: 16, textAlign: "left" }} title={提示} />}
        {/* 错误条撑开、收起，而不是砸下来又消失：下面的输入框跟着让位，位置不会跳 */}
        <AnimatePresence initial={false}>
          {error && (
            <motion.div
              key="err"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 秒(时长.base), ease: 曲线.ease }}
              style={{ overflow: "hidden" }}
            >
              <Alert type="error" title={error} showIcon style={{ marginBottom: 16 }} />
            </motion.div>
          )}
        </AnimatePresence>

        <Rise 第几个={1}>
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
        </Rise>

        {(可找回密码 || (桌面端 && 可注册 && 注册地址)) && (
          <Rise 第几个={2} style={{ display: "flex", justifyContent: "center", gap: 18, marginTop: 12, fontSize: 13 }}>
            {可找回密码 && <Link href="/forgot">忘记密码？</Link>}
            {/* 两端同一个入口、同一句话。桌面端那条要开系统浏览器（站外链接由 main.js
                的 setWindowOpenHandler 交出去），网页版就是站内跳转。
                注册开的是**云端账号**——网页版没有工作区这件事由注册页和登录失败那句话说，
                不在这个链接上解释，否则一个按钮要背一段话。 */}
            {可注册 && 注册地址 && (
              桌面端 ? (
                <a href={注册地址} target="_blank" rel="noreferrer">
                  注册新账号 ↗
                </a>
              ) : (
                <Link href={注册地址}>注册新账号</Link>
              )
            )}
          </Rise>
        )}

        {/*
          **把拦得住和拦不住的都说出来。**

          0.39.2 起数据按云端账号分开存（desktop/accounts.js），换个账号登录
          看到的是他自己那一份——这一句的前半段说的是这件事。
          但两个人如果共用同一个 macOS 登录，就共用同一套文件权限：
          拿任何 SQLite 工具直接打开对方那个库文件，应用层分目录是拦不住的。
          不说清楚的话，人会以为分了账号就等于上了锁，然后把真该分开的东西放进来。
          真要彻底隔开只有一条路——各用各的 macOS 账号，那时连数据根都是两份。
        */}
        {桌面端 && (
          <Rise 第几个={3} style={{ marginTop: 18, fontSize: 12, lineHeight: 1.7, textAlign: "center", color: "var(--text-muted)" }}>
            每个账号的数据在这台电脑上各存一份，换账号登录看到的是你自己的。
            <br />
            同一个电脑账户下的人仍能翻到彼此的数据文件；要彻底分开，请各用各的电脑账户。
          </Rise>
        )}
      </motion.div>
    </div>
  );
}
