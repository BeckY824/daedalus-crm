"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Form, Input, Button, Typography, Alert } from "antd";
import { UserOutlined, LockOutlined } from "@ant-design/icons";
import Logo from "@/components/Logo";
import { login, 桌面端登录 } from "./actions";
import Rise, { 缓动 } from "@/components/Rise";

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
   *   进场——卡片托一下（8px），里面按 标志 → 表单 → 底下那排链接 排队，一档 40ms。
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

    /*
      换了个云端账号登录：数据目录要跟着换（一个账号一份，见 desktop/accounts.js），
      而 DATABASE_URL 和 CRM_DATA_DIR 都是本地服务启动时读死的，非重起不可。
      所以这里**一步都不许往前走**——这会儿的 /dashboard 还是上一个人的库。

      原来这一段是「壳不在就退回硬跳转，至少不卡在这一屏」。那是 2026-09-20 那个
      bug 的正身：桥不在时（浏览器里打开的、桥没挂上）这一声没人接，页面落到
      /dashboard，而 /login 见还有令牌又自动登录回来，于是乙一路进了甲的库，
      一声不响。卡在这一屏都比那个好，所以现在宁可把话说清，让人自己重开应用。

      壳在就交给它：换目录、重起服务、把窗口重新载到新库的入口上。它的回话要等——
      从前这里是 void，换不了目录也没人知道（服务端已经拒绝往上一个人的库里写，
      人会停在一个既没进去也没报错的屏上）。
    */
    if (res.换账号) {
      const 壳 = typeof window !== "undefined" ? window.desktopShell : undefined;
      if (!壳?.switchAccount) {
        报错("已经换成这个账号了，但数据目录要跟着账号换、重起才生效。请退出应用再打开一次——两个账号的数据都在，一份都不会丢。");
        setLoading(false);
        return;
      }
      const r = await 壳.switchAccount().catch(() => ({ ok: false, error: "换不了数据目录" }));
      // 成了的话壳会把窗口重载到新库的入口，这一屏就此作废——保持转圈，不要闪一下
      if (!r?.ok) {
        报错(`${r?.error ?? "换不了数据目录"}。请退出应用再打开一次。`);
        setLoading(false);
      }
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
          opacity: { duration: 时长(0.28), ease: [...缓动] },
          y: { duration: 时长(0.28), ease: [...缓动] },
          x: { duration: 时长(0.25) },
        }}
      >
        <Rise 第几个={0} style={{ textAlign: "center", marginBottom: 28 }}>
          {/* 标志是**落定**的：从 0.8 长到 1，带一点点过冲（--ease-spring 那条曲线）。
              它是这一页第一个画完的东西，也是唯一一个允许"弹"的——底下的表单一律平静地上浮 */}
          <motion.div
            className="login-mark"
            initial={{ opacity: 0, scale: 少动 ? 1 : 0.8, y: 少动 ? 0 : -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 时长(0.5), ease: [0.24, 1.34, 0.38, 1] }}
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
              transition={{ duration: 时长(0.2), ease: "easeOut" }}
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
