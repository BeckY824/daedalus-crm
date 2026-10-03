"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Input, Button, Alert } from "antd";
import OtpInput from "@/components/OtpInput";
import { useMotionTheme } from "@/components/MotionTheme";
import AuthSide from "@/app/login/AuthSide";
import { 发送重置码, 重置密码 } from "./actions";

/**
 * 桌面端的找回密码（2026-10-03）：和登录页同一扇门——左栏一样，右边一步一屏。
 *
 *   邮箱 →「发验证码」→ 6 格验证码 → 设新密码 → 改好了，回去登录
 *
 * 动作和网页版共用（./actions.ts，桌面端那边转调云端）。成功后不自动登录：
 * 改密码会让所有机器退出，回登录页用新密码登一次，也顺手确认新密码真的能用。
 * 云端不支持自助找回（policy 不回 reset）时 可用=false，直说这条路走不通，不摆一个填了没反应的表单。
 */
type 步 = "邮箱" | "验证码" | "设密码" | "改好了";

const 重发冷却秒 = 60;

export default function DesktopForgot({ 可用 }: { 可用: boolean }) {
  const { 曲线, 时长 } = useMotionTheme();
  const 少动 = useReducedMotion();
  const 秒 = (t: number) => (少动 ? 0 : t);

  const [步骤, set步骤] = useState<步>("邮箱");
  const [邮箱, set邮箱] = useState("");
  const [码, set码] = useState("");
  const [密码, set密码] = useState("");
  const [码错, set码错] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [说明, set说明] = useState<string | null>(null);
  const [冷却, set冷却] = useState(0);
  const 密码框 = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (冷却 <= 0) return;
    const t = setTimeout(() => set冷却((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [冷却]);

  useEffect(() => {
    if (步骤 === "设密码") 密码框.current?.focus();
  }, [步骤]);

  const 去 = (s: 步) => {
    setError(null);
    set步骤(s);
  };

  async function 发码() {
    const t = 邮箱.trim();
    if (!t) return setError("请填注册时用的邮箱");
    setLoading(true);
    setError(null);
    try {
      const r = await 发送重置码(t);
      if (!r.ok) return setError(r.error);
      /*
        说的是「如果这个邮箱注册过」，不是「已发送」：服务端对没注册过的邮箱也回成功（否则这里就成了查号接口）
      */
      set说明(r.hint ?? `如果 ${t} 注册过，验证码已经发过去了，10 分钟内有效。`);
      set冷却(重发冷却秒);
      if (步骤 === "邮箱") {
        set码("");
        去("验证码");
      }
    } catch {
      setError("请求失败，请检查网络连接后重试");
    } finally {
      setLoading(false);
    }
  }

  async function 设新密码() {
    if (!密码) return setError("请设一个新密码");
    setLoading(true);
    setError(null);
    try {
      const r = await 重置密码({ target: 邮箱.trim(), code: 码, password: 密码 });
      if (!r.ok) {
        // 码不对 / 过期：退回输码那一步，格子抖一下清空——别让人在设密码这页对着一句「验证码不对」
        if (/验证码/.test(r.error)) {
          set码错((n) => n + 1);
          set步骤("验证码");
        }
        return setError(r.error);
      }
      去("改好了");
    } catch {
      setError("请求失败，请检查网络连接后重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth">
      <AuthSide />
      <main className="auth-main">
        <form
          className="auth-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (loading) return;
            if (步骤 === "邮箱") void 发码();
            else if (步骤 === "设密码") void 设新密码();
          }}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={可用 ? 步骤 : "不可用"}
              className="auth-step"
              initial={{ opacity: 0, x: 少动 ? 0 : 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 少动 ? 0 : -12 }}
              transition={{ duration: 秒(时长.base), ease: 曲线.ease }}
            >
              {!可用 && (
                <>
                  <h1>找回密码</h1>
                  <p className="auth-hint">云端这会儿还没开通自助找回。联系我们，我们人工帮你重置；本机数据不受影响。</p>
                  <p className="auth-alt">
                    <Link href="/login">返回登录</Link>
                  </p>
                </>
              )}

              {可用 && 步骤 === "邮箱" && (
                <>
                  <h1>找回密码</h1>
                  <p className="auth-hint">用注册时的邮箱收一个验证码，就能设新密码。</p>
                  <label className="auth-label" htmlFor="forgot-email">
                    邮箱
                  </label>
                  <Input
                    id="forgot-email"
                    size="large"
                    value={邮箱}
                    onChange={(e) => set邮箱(e.target.value)}
                    placeholder="you@company.com"
                    autoComplete="email"
                    autoFocus
                  />
                  <Button type="primary" htmlType="submit" size="large" block loading={loading}>
                    发验证码
                  </Button>
                  <p className="auth-alt">
                    想起来了？<Link href="/login">去登录</Link>
                  </p>
                </>
              )}

              {可用 && 步骤 === "验证码" && (
                <>
                  <h1>看一下邮箱</h1>
                  <p className="auth-hint">{说明}</p>
                  <OtpInput
                    错={码错}
                    禁用={loading}
                    onDone={(c) => {
                      set码(c);
                      去("设密码");
                    }}
                  />
                  <p className="auth-alt">
                    <button type="button" className="auth-link" onClick={() => 去("邮箱")}>
                      换个邮箱
                    </button>
                    {" · "}
                    {冷却 > 0 ? (
                      <span className="auth-num">{冷却} 秒后可重发</span>
                    ) : (
                      <button type="button" className="auth-link" onClick={() => void 发码()} disabled={loading}>
                        重发验证码
                      </button>
                    )}
                  </p>
                </>
              )}

              {可用 && 步骤 === "设密码" && (
                <>
                  <h1>设个新密码</h1>
                  <p className="auth-hint">
                    给 <b>{邮箱}</b> 设新密码。改好之后所有机器都要用新密码重新登录。
                  </p>
                  <input type="text" name="username" autoComplete="username" value={邮箱} readOnly hidden />
                  <label className="auth-label" htmlFor="forgot-newpw">
                    新密码
                  </label>
                  <Input.Password
                    id="forgot-newpw"
                    ref={(el) => {
                      密码框.current = el?.input ?? null;
                    }}
                    size="large"
                    value={密码}
                    onChange={(e) => set密码(e.target.value)}
                    autoComplete="new-password"
                    placeholder="至少 8 位，字母和数字都要有"
                  />
                  <Button type="primary" htmlType="submit" size="large" block loading={loading}>
                    设置新密码
                  </Button>
                  <p className="auth-alt">
                    <button type="button" className="auth-link" onClick={() => 去("验证码")}>
                      返回改验证码
                    </button>
                  </p>
                </>
              )}

              {可用 && 步骤 === "改好了" && (
                <>
                  <h1>密码改好了</h1>
                  <p className="auth-hint" role="status">
                    所有地方都要用新密码重新登录：网页端的登录状态已经作废，桌面端已登录的机器也一起退出了。本机数据不受影响。
                  </p>
                  <Link href="/login">
                    <Button type="primary" size="large" block>
                      去登录
                    </Button>
                  </Link>
                </>
              )}
            </motion.div>
          </AnimatePresence>

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
                <Alert type="error" showIcon title={error} className="auth-alert" />
              </motion.div>
            )}
          </AnimatePresence>
        </form>
      </main>
    </div>
  );
}
