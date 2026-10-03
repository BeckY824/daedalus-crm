"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Input, Button, Checkbox, Alert } from "antd";
import OtpInput from "@/components/OtpInput";
import { useMotionTheme } from "@/components/MotionTheme";
import { 桌面端登录, 桌面端下一步, 桌面端注册, type LoginResult } from "./actions";
import { 登录之后 } from "./after-login";
import AuthSide from "./AuthSide";

/**
 * 桌面端的门：**一个邮箱框走到底**（2026-10-02 起，原型见 ~/CRM/新功能三线-规划-2026-10-02.md）。
 *
 *   邮箱 →「继续」→ 云端说这个号注册过没有
 *     注册过            → 输密码 → 进去
 *     没注册、要验证码   → 6 位码 → 设密码、勾条款 → 开号并直接进去
 *     没注册、不要验证码 → 设密码、勾条款 → 同上
 *   填的是手机号（老账号才有）→ 直接输密码
 *
 * 原来注册要开浏览器去网页办，回来再登录：新用户在门口就要切两次窗口，
 * 而且是在还没见过产品长什么样的时候。现在整条路都在这扇窗里。
 *
 * 桌面端一律用这张（2026-10-03 起，原来那张 LoginForm 不再给桌面端用）。
 * 云端还没有 /api/account/signup/*（policy 不回 inApp）时：「继续」直接去输密码，那一步给「注册新账号 ↗」开浏览器——
 * 两边谁先升级都不会摆出一个点了报错的入口。
 */

type 步 = "邮箱" | "密码" | "验证码" | "设密码";

/**
 * server action 迟迟不返回时的上限。注册那条路是「云端注册 + 云端登录」两趟，每趟云端那边 20 秒超时，
 * 加上换目录，最坏一分钟——原来 40 秒，服务端还在跑就先报了超时（第六轮 C6）
 */
const 请求超时毫秒 = 65000;
/** 重发验证码的冷却。云端按 IP 另有限流，这里只是别让人连点 */
const 重发冷却秒 = 60;

function 限时<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 请求超时毫秒))]);
}
const 网络错 = (e: unknown) =>
  e instanceof Error && e.message === "timeout" ? "服务器无响应，请检查网络连接后重试" : "请求失败，请检查网络连接后重试";

export default function DesktopAuth({
  可找回密码,
  可注册,
  应用内注册,
  注册地址,
  提示,
}: {
  可找回密码: boolean;
  可注册: boolean;
  /** 云端有没有应用内注册的接口（policy 的 inApp）。没有就开浏览器去注册 */
  应用内注册: boolean;
  注册地址: string;
  提示?: string;
}) {
  const { 曲线, 时长 } = useMotionTheme();
  const 少动 = useReducedMotion();
  const 秒 = (t: number) => (少动 ? 0 : t);

  const [步骤, set步骤] = useState<步>("邮箱");
  const [邮箱, set邮箱] = useState("");
  const [密码, set密码] = useState("");
  const [码, set码] = useState("");
  const [同意, set同意] = useState(false);
  const [码错, set码错] = useState(0);
  /** 这一次进输码页是不是因为码错被退回来的：是的话格子一出来就红一下、抖一下（见 OtpInput 的 进来先抖） */
  const [码错退回, set码错退回] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [说明, set说明] = useState<string | null>(null);
  const [冷却, set冷却] = useState(0);
  const 密码框 = useRef<HTMLInputElement>(null);
  const 邮箱框 = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (冷却 <= 0) return;
    const t = setTimeout(() => set冷却((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [冷却]);

  // 换了一步，焦点跟过去：人不该再伸手去点输入框
  useEffect(() => {
    if (步骤 === "密码" || 步骤 === "设密码") 密码框.current?.focus();
    if (步骤 === "邮箱") 邮箱框.current?.focus();
  }, [步骤]);

  const 去 = (s: 步) => {
    setError(null);
    set码错退回(false);
    set步骤(s);
  };

  async function 继续() {
    const t = 邮箱.trim();
    if (!t) return setError("请填邮箱");
    // 云端不收新注册、或者还没有应用内注册的接口时不问它，直接当老账号输密码——问了也只会回一句「没开放」/ 404
    if (!可注册 || !应用内注册) return 去("密码");
    setLoading(true);
    setError(null);
    try {
      const r = await 限时(桌面端下一步(t));
      if (!r.ok) return setError(r.error);
      if (r.data.去 === "验证码") {
        set说明(r.data.hint ?? null);
        set码("");
        set冷却(重发冷却秒);
      }
      去(r.data.去);
    } catch (e) {
      setError(网络错(e));
    } finally {
      setLoading(false);
    }
  }

  async function 重发() {
    if (冷却 > 0) return;
    setLoading(true);
    try {
      const r = await 限时(桌面端下一步(邮箱.trim()));
      if (!r.ok) return setError(r.error);
      setError(null);
      set说明(r.data.去 === "验证码" ? (r.data.hint ?? "新的验证码发出去了") : null);
      set冷却(重发冷却秒);
    } catch (e) {
      setError(网络错(e));
    } finally {
      setLoading(false);
    }
  }

  async function 进去(p: Promise<LoginResult>) {
    setLoading(true);
    setError(null);
    let res: LoginResult;
    try {
      res = await 限时(p);
    } catch (e) {
      setError(网络错(e));
      setLoading(false);
      return;
    }
    if (!res.ok) {
      // 号已经开好、只是没登进去：带去输密码那一步（刚设的密码还在框里），别让人再注册一遍（第六轮 C6）
      if (res.已开号) {
        set码("");
        set步骤("密码");
        setError(res.error);
        setLoading(false);
        return;
      }
      // 码不对 / 过期：退回输码那一步，格子抖一下清空，别让人在设密码这页对着一句「验证码不对」
      if (步骤 === "设密码" && 码 && /验证码/.test(res.error)) {
        set码错((n) => n + 1);
        set码错退回(true);
        set步骤("验证码");
      }
      setError(res.error);
      setLoading(false);
      return;
    }
    await 登录之后(res, (msg) => {
      setError(msg);
      setLoading(false);
    });
  }

  const 新号 = 步骤 === "验证码" || 步骤 === "设密码";

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
            if (步骤 === "邮箱") void 继续();
            else if (步骤 === "密码") void 进去(桌面端登录(邮箱, 密码));
            else if (步骤 === "设密码") {
              if (!同意) return setError("请先阅读并同意用户协议和隐私政策");
              void 进去(桌面端注册({ target: 邮箱, code: 码 || undefined, password: 密码, agreed: 同意 }));
            }
          }}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={步骤}
              className="auth-step"
              initial={{ opacity: 0, x: 少动 ? 0 : 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 少动 ? 0 : -12 }}
              transition={{ duration: 秒(时长.base), ease: 曲线.ease }}
            >
              {步骤 === "邮箱" && (
                <>
                  <h1>{可注册 ? "登录或注册" : "登录"}</h1>
                  <p className="auth-hint">
                    {!可注册 ? "用你的云端账号登录。" : 应用内注册 ? "新邮箱会直接开一个账号，不用去网页。" : "填你的邮箱继续。还没有账号的，下一步可以注册。"}
                  </p>
                  <label className="auth-label" htmlFor="auth-email">
                    邮箱
                  </label>
                  <Input
                    id="auth-email"
                    ref={(el) => {
                      邮箱框.current = el?.input ?? null;
                    }}
                    size="large"
                    value={邮箱}
                    onChange={(e) => set邮箱(e.target.value)}
                    placeholder="you@company.com"
                    autoComplete="username"
                    autoFocus
                  />
                  <Button type="primary" htmlType="submit" size="large" block loading={loading}>
                    继续
                  </Button>
                  {/* 知道自己有账号的人不用等云端那一问：直接去输密码。老账号的手机号也填在上面这一格 */}
                  <p className="auth-alt">
                    已经有密码？
                    <button
                      type="button"
                      className="auth-link"
                      onClick={() => {
                        if (!邮箱.trim()) {
                          setError("先在上面填邮箱（老账号也可以填手机号）");
                          邮箱框.current?.focus();
                          return;
                        }
                        去("密码");
                      }}
                    >
                      用密码登录
                    </button>
                  </p>
                </>
              )}

              {步骤 === "密码" && (
                <>
                  <h1>输入密码</h1>
                  <p className="auth-hint">
                    <b>{邮箱}</b>
                    <button type="button" className="auth-link" onClick={() => 去("邮箱")}>
                      换一个
                    </button>
                  </p>
                  {/* 密码管理器要看见用户名那一格才知道这是哪个账号的密码 */}
                  <input type="text" name="username" autoComplete="username" value={邮箱} readOnly hidden />
                  <label className="auth-label" htmlFor="auth-pw">
                    密码
                  </label>
                  <Input.Password
                    autoFocus
                    id="auth-pw"
                    ref={(el) => {
                      密码框.current = el?.input ?? null;
                    }}
                    size="large"
                    value={密码}
                    onChange={(e) => set密码(e.target.value)}
                    autoComplete="current-password"
                  />
                  <Button type="primary" htmlType="submit" size="large" block loading={loading}>
                    登录
                  </Button>
                  {(可找回密码 || (可注册 && !应用内注册)) && (
                    <p className="auth-alt">
                      {可找回密码 && <Link href="/forgot">忘记密码？</Link>}
                      {/* 云端还没有应用内注册：新用户在这一步去网页开号，回来接着在这里登录 */}
                      {可注册 && !应用内注册 && (
                        <>
                          {可找回密码 && " · "}
                          还没有账号？
                          <a href={注册地址} target="_blank" rel="noopener noreferrer">
                            注册新账号 ↗
                          </a>
                        </>
                      )}
                    </p>
                  )}
                </>
              )}

              {步骤 === "验证码" && (
                <>
                  <h1>看一下邮箱</h1>
                  <p className="auth-hint">
                    验证码发到了 <b>{邮箱}</b>，10 分钟内有效。
                  </p>
                  <OtpInput
                    错={码错}
                    进来先抖={码错退回}
                    禁用={loading}
                    onDone={(c) => {
                      set码(c);
                      去("设密码");
                    }}
                  />
                  {说明 && <p className="auth-alt">{说明}</p>}
                  <p className="auth-alt">
                    <button type="button" className="auth-link" onClick={() => 去("邮箱")}>
                      换个邮箱
                    </button>
                    {" · "}
                    {冷却 > 0 ? (
                      <span className="auth-num">{冷却} 秒后可重发</span>
                    ) : (
                      <button type="button" className="auth-link" onClick={() => void 重发()} disabled={loading}>
                        重发验证码
                      </button>
                    )}
                  </p>
                </>
              )}

              {步骤 === "设密码" && (
                <>
                  <h1>设个密码</h1>
                  <p className="auth-hint">
                    给 <b>{邮箱}</b> 开账号。以后在别的电脑上也用这套邮箱密码登录。
                  </p>
                  <input type="text" name="username" autoComplete="username" value={邮箱} readOnly hidden />
                  <label className="auth-label" htmlFor="auth-newpw">
                    密码
                  </label>
                  <Input.Password
                    autoFocus
                    id="auth-newpw"
                    ref={(el) => {
                      密码框.current = el?.input ?? null;
                    }}
                    size="large"
                    value={密码}
                    onChange={(e) => set密码(e.target.value)}
                    autoComplete="new-password"
                    placeholder="至少 8 位，字母和数字都要有"
                  />
                  <Checkbox checked={同意} onChange={(e) => set同意(e.target.checked)} className="auth-agree">
                    我已阅读并同意
                    <Link href="/terms" target="_blank">
                      用户协议
                    </Link>
                    和
                    <Link href="/privacy" target="_blank">
                      隐私政策
                    </Link>
                  </Checkbox>
                  <Button type="primary" htmlType="submit" size="large" block loading={loading}>
                    注册并进入
                  </Button>
                  {码 && (
                    <p className="auth-alt">
                      <button type="button" className="auth-link" onClick={() => 去("验证码")}>
                        返回改验证码
                      </button>
                    </p>
                  )}
                </>
              )}
            </motion.div>
          </AnimatePresence>

          {提示 && !新号 && <Alert type="warning" showIcon title={提示} className="auth-alert" />}
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
